import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AuditAction, AuditLog, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const AUDIT_CHAIN_LOCK_KEY = 727310;
const CURRENT_HASH_VERSION = 2;
const LEGACY_HASH_VERSION_V0 = 0;
const LEGACY_HASH_VERSION_V1 = 1;

// verifyChain() walks the audit_logs table in batches of this many rows
// (cursor-paginated on `sequence`) instead of loading the whole table into
// memory at once. At realistic scale (every folder/document view is
// audited) this table grows into the millions of rows; a single
// `findMany()` over the whole thing OOMs the API container exactly when
// it's needed most (a compliance incident). Configurable via
// AUDIT_VERIFY_BATCH_SIZE for tests that want to exercise the
// multi-batch path without seeding tens of thousands of rows.
const DEFAULT_VERIFY_BATCH_SIZE = Number(process.env.AUDIT_VERIFY_BATCH_SIZE) || 10000;

interface RecordAuditEntry {
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
  details?: Record<string, string>;
}

// Exported so the unit tests can hand-construct inputs and call the
// private computeHash directly to prove hash-format properties (e.g. that
// v2's `details` serialization is injective) without needing an end-to-end
// DB round trip for every case.
export interface HashInput {
  hashVersion: number;
  id: string;
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
  createdAt: Date;
  prevHash: string | null;
  details: Record<string, string> | null | undefined;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: RecordAuditEntry): Promise<AuditLog> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;

      const last = await tx.auditLog.findFirst({ orderBy: { sequence: 'desc' } });
      const prevHash = last?.hash ?? null;

      const id = randomUUID();
      const createdAt = new Date();
      const hashVersion = CURRENT_HASH_VERSION;
      const hash = this.computeHash({
        hashVersion,
        id,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        ipAddress: entry.ipAddress,
        createdAt,
        prevHash,
        details: entry.details,
      });

      return tx.auditLog.create({
        data: {
          id,
          actorId: entry.actorId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          ipAddress: entry.ipAddress,
          createdAt,
          prevHash,
          hash,
          hashVersion,
          details: entry.details,
        },
      });
    });
  }

  // Same as record(), but never throws. The audit write runs in its own
  // transaction AFTER the caller's business-operation transaction has
  // already committed, so a failure here must not turn an already-successful
  // folder/document/permission change into an unhandled 500 for the client.
  // On failure the full entry payload and the error are logged so the gap
  // itself is visible (matching this project's existing
  // console.error-on-stream-failure convention in
  // documents.controller.ts's download handler) instead of failing silently.
  async recordSafely(entry: RecordAuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (err) {
      console.error('Failed to write audit log entry (business operation already succeeded):', entry, err);
    }
  }

  async verifyChain(
    batchSize: number = DEFAULT_VERIFY_BATCH_SIZE,
  ): Promise<{ valid: boolean; brokenAtId?: string }> {
    let expectedPrevHash: string | null = null;
    let cursorSequence: bigint | undefined;

    for (;;) {
      const rows: AuditLog[] = await this.prisma.auditLog.findMany({
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
        if (!this.isValidChainRow(row, expectedPrevHash)) {
          return { valid: false, brokenAtId: row.id };
        }
        expectedPrevHash = row.hash;
      }

      cursorSequence = rows[rows.length - 1].sequence;

      if (rows.length < batchSize) {
        break;
      }
    }

    return { valid: true };
  }

  async listForResource(resourceType: ResourceType, resourceId: string): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { resourceType, resourceId },
      orderBy: { sequence: 'asc' },
    });
  }

  private isValidChainRow(row: AuditLog, expectedPrevHash: string | null): boolean {
    if (row.prevHash !== expectedPrevHash) return false;

    // hashVersion 0 的雜湊輸入不包含 details；因此任何非 null 的 details
    // 都代表資料遭到竄改，即使重新計算雜湊仍可能一致。
    if (row.hashVersion === LEGACY_HASH_VERSION_V0 && row.details !== null) return false;

    return this.computeHash({
      hashVersion: row.hashVersion,
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt,
      prevHash: row.prevHash,
      details: row.details as Record<string, string> | null,
    }) === row.hash;
  }

  private computeHash(input: HashInput): string {
    // hashVersion 0 is the legacy pre-versioning format (id|actorId|action|
    // resourceType|resourceId|ipAddress|createdAt|prevHash) that every row
    // written before the hashVersion/details migration used — those rows
    // predate hashVersion existing at all, so they're marked 0 rather than
    // re-hashed, and verifyChain must keep reproducing their original input
    // exactly to still validate them.
    if (input.hashVersion === LEGACY_HASH_VERSION_V0) {
      const raw = [
        input.id,
        input.actorId,
        input.action,
        input.resourceType,
        input.resourceId,
        input.ipAddress ?? '',
        input.createdAt.toISOString(),
        input.prevHash ?? '',
      ].join('|');
      return createHash('sha256').update(raw).digest('hex');
    }

    // hashVersion 1 is the first `details`-aware format, written by every
    // row created between the hashVersion/details migration and the fix
    // that replaced this serialization (below). It is LEGACY and
    // READ-ONLY: its `details` serialization is `key=value` pairs joined
    // by `,` with NEITHER keys NOR values escaped, which is not injective
    // — e.g. `{permissionLevel: 'view,principalId=attacker', ...}` and
    // `{permissionLevel: 'view', principalId: 'attacker', ...}` can
    // serialize to the identical string, letting a forged `details` object
    // hash-collide with a genuine one. Real rows in this project's dev DB
    // were actually written under this flawed format, so it must be kept
    // exactly as-is (byte-for-byte) forever so verifyChain can keep
    // validating them under the format they were truly hashed with —
    // "fixing" it here would itself be indistinguishable from tampering.
    // hashVersion 2 (CURRENT_HASH_VERSION, below) is the fix: do not add
    // new writes under version 1.
    if (input.hashVersion === LEGACY_HASH_VERSION_V1) {
      const serializedDetails = Object.keys(input.details ?? {})
        .sort((a, b) => a.localeCompare(b))
        .map((k) => `${k}=${input.details![k]}`)
        .join(',');

      const raw = [
        input.hashVersion,
        input.id,
        input.actorId,
        input.action,
        input.resourceType,
        input.resourceId,
        input.ipAddress ?? '',
        input.createdAt.toISOString(),
        input.prevHash ?? '',
        serializedDetails,
      ].join('|');
      return createHash('sha256').update(raw).digest('hex');
    }

    // hashVersion 2 (CURRENT_HASH_VERSION): same shape as version 1, but
    // with an INJECTIVE `details` serialization. Each sorted key/value pair
    // is individually run through JSON.stringify before being joined —
    // JSON string encoding unambiguously escapes any `"`, `,`, `:`, or `=`
    // that appears inside a key or value, so two distinct `details` objects
    // can never produce the same serialized string (unlike the bare
    // `key=value` concatenation used by version 1).
    const serializedDetails = Object.keys(input.details ?? {})
      .sort((a, b) => a.localeCompare(b))
      .map((k) => `${JSON.stringify(k)}:${JSON.stringify(input.details![k])}`)
      .join(',');

    const raw = [
      input.hashVersion,
      input.id,
      input.actorId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.ipAddress ?? '',
      input.createdAt.toISOString(),
      input.prevHash ?? '',
      serializedDetails,
    ].join('|');
    return createHash('sha256').update(raw).digest('hex');
  }
}
