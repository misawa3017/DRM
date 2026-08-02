import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';

// clamscan ships as CJS with no bundled/DefinitelyTyped types. These
// interfaces describe only the surface this service actually touches,
// verified against the real installed clamscan@2.4.0 source
// (node_modules/clamscan/index.js):
//   - `require('clamscan')` resolves directly to the `NodeClam` class (the
//     file ends with `module.exports = NodeClam;`).
//   - `new NodeClam().init(options)` returns a Promise of the initialized
//     instance itself (not a separate client object).
//   - `scanStream(stream)` returns `Promise<{ isInfected, viruses, file? }>`
//     -- confirmed working against the real clamav service in this
//     project's scripts/verify-clamav.sh (Phase 4A), which used the same
//     package's `isInfected()` file-scan method; `scanStream` is documented
//     (see clamscan's API.md) as the buffer/stream-scanning counterpart,
//     requiring only the clamdscan TCP host/port config used below -- no
//     temp file ever needs to be written.
interface ClamScanInitOptions {
  removeInfected: boolean;
  scanRecursively: boolean;
  clamscan: { active: boolean };
  clamdscan: { host: string; port: number; timeout: number; localFallback: boolean };
  preference: 'clamdscan' | 'clamscan';
}

interface ClamScanRawResult {
  isInfected: boolean | null;
  viruses: string[] | null;
}

interface ClamScanClient {
  scanStream(stream: Readable): Promise<ClamScanRawResult>;
}

interface NodeClamInstance {
  init(options: ClamScanInitOptions): Promise<ClamScanClient>;
}

interface NodeClamCtor {
  new (): NodeClamInstance;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- clamscan ships CJS-only with no bundled/DefinitelyTyped types; see comment above.
const NodeClam = require('clamscan') as NodeClamCtor;

export interface ScanResult {
  isInfected: boolean;
  viruses: string[];
}

// Thrown by scanBuffer when clamd resolves the scan with `isInfected: null`
// (its documented signal for "COMMAND READ TIMED OUT" or any response that
// doesn't match the known OK/FOUND/ERROR patterns -- see the comment on
// scanBuffer below). Distinguished from a generic Error so
// DocumentsService.rejectIfInfected can translate it into a clear 503
// instead of it falling through as an unhandled 500, and can never
// mistake it for the (also-null-coercible-to-false) "clean" result.
export class VirusScanIndeterminateError extends Error {}

// Thrown by scanBuffer when clamd rejects the scan with its own
// "size limit exceeded" ERROR response (clamd's INSTREAM size limit,
// StreamMaxLength in clamd.conf). Distinguished so the caller can translate
// it into a 413 instead of an unhandled 500.
export class VirusScanSizeLimitError extends Error {}

@Injectable()
export class VirusScanService {
  private readonly logger = new Logger(VirusScanService.name);
  private clamscanPromise: Promise<ClamScanClient> | undefined;

  // Lazily creates (and, on failure, re-creates) the clamscan client instead
  // of memoizing a single promise for the process lifetime. `init()` pings
  // clamd immediately, so if clamd is unreachable the first time this is
  // called (e.g. down/restarting at api boot, or crashed and restarted
  // later while api keeps running -- this project has seen clamd crash
  // under memory pressure, see docker-compose.yml's clamav comment), the
  // rejection clears `clamscanPromise` so the *next* scanBuffer call tries
  // init() again instead of replaying the same cached rejection forever.
  private async getClient(): Promise<ClamScanClient> {
    if (!this.clamscanPromise) {
      this.clamscanPromise = new NodeClam()
        .init({
          removeInfected: false,
          scanRecursively: false,
          // Never attempt to shell out to a local `clamscan`/`clamdscan`
          // binary (neither exists in this container) -- always talk to
          // the real clamd daemon over TCP. Matches the config verified
          // working against real ClamAV in Phase 4A's
          // scripts/verify-clamav.sh.
          clamscan: {
            active: false,
          },
          clamdscan: {
            host: process.env.CLAMAV_HOST ?? 'clamav',
            port: Number(process.env.CLAMAV_PORT ?? 3310),
            timeout: 60000,
            localFallback: false,
          },
          preference: 'clamdscan',
        })
        .catch((err: unknown) => {
          this.clamscanPromise = undefined;
          throw err;
        });
    }
    return this.clamscanPromise;
  }

  // Scans `buffer` against the real clamd daemon. Two distinct failure
  // shapes, both verified against the real installed clamscan@2.4.0 source
  // (node_modules/clamscan/index.js):
  //
  //   1. scanStream() can *resolve* with `isInfected: null` -- clamd's
  //      "COMMAND READ TIMED OUT" response, or any response that doesn't
  //      match clamscan's known OK/FOUND/ERROR patterns. Coercing that to
  //      `false` (as this method used to) would silently treat an
  //      ambiguous scan as "clean" and let the upload proceed -- a
  //      fail-open bypass of this phase's central security control. Treat
  //      it as a scan failure instead (fail closed) and log it, so an
  //      ambiguous-scan event is visible to ops rather than invisible.
  //   2. scanStream() can *reject* with a clamd "... ERROR" response, most
  //      notably "INSTREAM size limit exceeded" when the buffer exceeds
  //      clamd.conf's StreamMaxLength. Recognized by message and re-thrown
  //      as a distinct, typed error so the caller can surface a clean 413
  //      instead of a raw 500.
  async scanBuffer(buffer: Buffer): Promise<ScanResult> {
    const clamscan = await this.getClient();
    const stream = Readable.from(buffer);

    let rawResult: ClamScanRawResult;
    try {
      rawResult = await clamscan.scanStream(stream);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/size limit exceeded/i.test(message)) {
        throw new VirusScanSizeLimitError(
          `Virus scan rejected the upload: ${message}`,
        );
      }
      throw err;
    }

    const { isInfected, viruses } = rawResult;
    if (isInfected === null || isInfected === undefined) {
      this.logger.error(
        `ClamAV scan returned an indeterminate result (no clean/infected verdict -- likely a clamd timeout or unrecognized response). Failing closed and rejecting the upload. viruses field: ${JSON.stringify(
          viruses,
        )}`,
      );
      throw new VirusScanIndeterminateError(
        'Virus scan could not be completed: clamd returned an indeterminate result',
      );
    }

    return { isInfected, viruses: viruses ?? [] };
  }
}
