import { Injectable } from '@nestjs/common';
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

@Injectable()
export class VirusScanService {
  private readonly clamscanPromise: Promise<ClamScanClient>;

  constructor() {
    this.clamscanPromise = new NodeClam().init({
      removeInfected: false,
      scanRecursively: false,
      // Never attempt to shell out to a local `clamscan`/`clamdscan`
      // binary (neither exists in this container) -- always talk to the
      // real clamd daemon over TCP. Matches the config verified working
      // against real ClamAV in Phase 4A's scripts/verify-clamav.sh.
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
    });
    // Attach a no-op handler now so a rejected init (e.g. clamd unreachable
    // at boot) doesn't surface as an unhandled promise rejection warning
    // before the first real scanBuffer() call attaches its own handler via
    // `await`. The original promise (awaited in scanBuffer) still carries
    // the rejection normally -- this only silences the premature warning.
    this.clamscanPromise.catch(() => {});
  }

  async scanBuffer(buffer: Buffer): Promise<ScanResult> {
    const clamscan = await this.clamscanPromise;
    const stream = Readable.from(buffer);
    const { isInfected, viruses } = await clamscan.scanStream(stream);
    return { isInfected: !!isInfected, viruses: viruses ?? [] };
  }
}
