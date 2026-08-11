/**
 * Backfills `AuditLog.hashVersion` for rows whose label doesn't match the
 * hash format they were actually written under.
 *
 * Why this is needed: the migration that added `hashVersion`
 * (`../migrations/20260801133937_audit_log_hash_version_details`) used
 * `ADD COLUMN "hashVersion" INTEGER NOT NULL DEFAULT 1` with no backfill
 * `UPDATE`. Any row that already existed in a database before that
 * migration ran was actually hashed under the pre-versioning legacy format
 * (see `AuditService.computeHash`'s `hashVersion 0` branch), but Postgres
 * silently stamped it `hashVersion: 1` via the column default anyway. Left
 * alone, `AuditService.verifyChain()` recomputes those rows' hashes using
 * the wrong format and reports the whole chain broken, even though nothing
 * was actually tampered with.
 *
 * What this script does, per row: recompute the row's hash under every
 * known historical format (0, 1, and 2 -- see below on why 2 is included)
 * and relabel `hashVersion` to whichever format's recomputed hash actually
 * matches the row's stored `hash`. If a row's stored hash matches NONE of
 * the known formats, this is either genuine tampering or an unhandled hash
 * format change that this script hasn't been taught about -- either way it
 * needs a human, not a guess, so the script logs that row's `id` and
 * immediately stops (non-zero exit, no further writes past the unmatched
 * row) rather than silently leaving it mislabeled or guessing a version.
 *
 * The table is walked in `sequence`-cursor batches (same `take` +
 * `cursor: { sequence }` + `skip: 1` pattern as
 * `AuditService.verifyChain()`) rather than a single unbounded
 * `findMany()`, so this script doesn't OOM the process it's run from when
 * pointed at a large, already-populated database -- exactly the situation
 * this script exists to handle. Configurable via
 * `AUDIT_BACKFILL_BATCH_SIZE` for tests that want to exercise the
 * multi-batch path without seeding a huge table.
 *
 * Why format 2 (the current, non-legacy format) is included even though
 * this is nominally a "legacy" backfill: this script is meant to be safe
 * to run against a live database that also already contains rows written
 * under the CURRENT format (e.g. any row written by the API after this
 * fix's deployment). Without checking format 2 too, every already-correct
 * current-format row would come back "unmatched" and trip the hard-fail
 * path on every run, which defeats the idempotency requirement below. As a
 * fast path, a row whose stored hash already matches its own current
 * `hashVersion` label is left untouched without even considering
 * relabeling it to a different (also-matching) version -- see the note
 * inline below on why that ambiguity is intentionally impossible in
 * practice.
 *
 * Idempotent: rows already correctly labeled are left alone (no write
 * happens; they're just re-confirmed). Re-running this script after it has
 * already fixed a database is a no-op.
 *
 * The three hash-format functions below are hand-copied from
 * `AuditService.computeHash`'s three branches (byte-for-byte, including
 * the flawed non-injective v1 `details` serialization) rather than
 * imported, so this script has no dependency on NestJS wiring and can run
 * standalone with just a `DATABASE_URL` (via `ts-node`, no build step
 * required). This means the three functions here and the three branches in
 * `computeHash` must be kept in sync by hand if a format's definition ever
 * needs to change -- but for formats 0 and 1 that must never happen (they
 * are frozen legacy formats by definition), and for format 2, any future
 * v3 fix should add a fourth branch/function pair here and there rather
 * than editing this one.
 *
 * Usage (see also the note near the hashVersion column's migration file):
 *   DATABASE_URL=postgresql://user:pass@host:port/db \
 *     pnpm --filter api exec ts-node prisma/scripts/backfill-hash-version.ts
 */
import { PrismaClient, AuditAction, AuditLog, ResourceType } from '@prisma/client';
import { createHash } from 'crypto';

interface RowForHashing {
  id: string;
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
  createdAt: Date;
  prevHash: string | null;
  details: Record<string, string> | null;
}

// hashVersion 0 -- pre-versioning legacy format. Mirrors
// AuditService.computeHash's LEGACY_HASH_VERSION_V0 branch exactly.
function computeHashV0(row: RowForHashing): string {
  const raw = [
    row.id,
    row.actorId,
    row.action,
    row.resourceType,
    row.resourceId,
    row.ipAddress ?? '',
    row.createdAt.toISOString(),
    row.prevHash ?? '',
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

// hashVersion 1 -- first details-aware format, with the flawed
// non-injective `key=value` serialization. Mirrors
// AuditService.computeHash's LEGACY_HASH_VERSION_V1 branch exactly
// (including the flaw -- this format must be reproduced as-is, not fixed).
function computeHashV1(row: RowForHashing): string {
  const serializedDetails = Object.keys(row.details ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${row.details![k]}`)
    .join(',');

  const raw = [
    1,
    row.id,
    row.actorId,
    row.action,
    row.resourceType,
    row.resourceId,
    row.ipAddress ?? '',
    row.createdAt.toISOString(),
    row.prevHash ?? '',
    serializedDetails,
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

// hashVersion 2 -- current format, injective `details` serialization.
// Mirrors AuditService.computeHash's CURRENT_HASH_VERSION branch exactly.
function computeHashV2(row: RowForHashing): string {
  const serializedDetails = Object.keys(row.details ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(row.details![k])}`)
    .join(',');

  const raw = [
    2,
    row.id,
    row.actorId,
    row.action,
    row.resourceType,
    row.resourceId,
    row.ipAddress ?? '',
    row.createdAt.toISOString(),
    row.prevHash ?? '',
    serializedDetails,
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

// Ordered oldest-to-newest; used both to find the first legacy format that
// matches an out-of-band row and to fast-path-confirm a row's own current
// label. In practice a valid hash can only ever match ONE of these three
// (sha256 collisions across genuinely different input strings are not a
// realistic concern here), so "first match wins" never actually discards
// an alternative -- there isn't one.
const KNOWN_FORMATS: { version: number; compute: (row: RowForHashing) => string }[] = [
  { version: 0, compute: computeHashV0 },
  { version: 1, compute: computeHashV1 },
  { version: 2, compute: computeHashV2 },
];

const DEFAULT_BACKFILL_BATCH_SIZE = Number(process.env.AUDIT_BACKFILL_BATCH_SIZE) || 10000;

function toRowForHashing(row: AuditLog): RowForHashing {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt,
    prevHash: row.prevHash,
    details: row.details as Record<string, string> | null,
  };
}

async function reconcileHashVersion(prisma: PrismaClient, row: AuditLog): Promise<'already-correct' | 'relabeled' | 'unmatched'> {
  const rowForHashing = toRowForHashing(row);
  const currentFormat = KNOWN_FORMATS.find((format) => format.version === row.hashVersion);
  if (currentFormat?.compute(rowForHashing) === row.hash) return 'already-correct';

  const matchingFormat = KNOWN_FORMATS.find((format) => format.compute(rowForHashing) === row.hash);
  if (!matchingFormat) return 'unmatched';

  await prisma.auditLog.update({
    where: { id: row.id },
    data: { hashVersion: matchingFormat.version },
  });
  console.log(`  relabeled ${row.id}: hashVersion ${row.hashVersion} -> ${matchingFormat.version}`);
  return 'relabeled';
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const batchSize = DEFAULT_BACKFILL_BATCH_SIZE;

  try {
    let alreadyCorrect = 0;
    let relabeled = 0;
    let checked = 0;
    let cursorSequence: bigint | undefined;
    let unmatchedId: string | undefined;

    for (;;) {
      const rows = await prisma.auditLog.findMany({
        orderBy: { sequence: 'asc' },
        take: batchSize,
        ...(cursorSequence !== undefined
          ? { cursor: { sequence: cursorSequence }, skip: 1 }
          : {}),
      });

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        checked++;
        const result = await reconcileHashVersion(prisma, row);
        if (result === 'already-correct') {
          alreadyCorrect++;
          continue;
        }
        if (result === 'unmatched') {
          unmatchedId = row.id;
          break;
        }
        relabeled++;
      }

      if (unmatchedId !== undefined) {
        break;
      }

      cursorSequence = rows[rows.length - 1].sequence;

      if (rows.length < batchSize) {
        break;
      }
    }

    if (unmatchedId !== undefined) {
      console.error(
        `FATAL: row ${unmatchedId} matched NONE of the known hash formats (0, 1, 2). ` +
          'This means either genuine tampering or an unhandled hash format -- refusing to guess. ' +
          `Checked ${checked} row(s) before stopping (${alreadyCorrect} already correct, ${relabeled} relabeled).`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `Done. Checked ${checked} row(s): ${alreadyCorrect} already correctly labeled, ${relabeled} relabeled, 0 unmatched.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Backfill script failed:', err);
  process.exitCode = 1;
});
