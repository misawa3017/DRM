import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AuditAction, AuditLog, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const AUDIT_CHAIN_LOCK_KEY = 727310;
const CURRENT_HASH_VERSION = 1;
const LEGACY_HASH_VERSION = 0;

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

interface HashInput {
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
        if (row.prevHash !== expectedPrevHash) {
          return { valid: false, brokenAtId: row.id };
        }
        const recomputed = this.computeHash({
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
        });
        if (recomputed !== row.hash) {
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

  private computeHash(input: HashInput): string {
    // hashVersion 0 is the legacy pre-versioning format (id|actorId|action|
    // resourceType|resourceId|ipAddress|createdAt|prevHash) that every row
    // written before this hashVersion/details migration used — those rows
    // predate hashVersion existing at all, so they're marked 0 rather than
    // re-hashed, and verifyChain must keep reproducing their original input
    // exactly to still validate them. hashVersion 1 (CURRENT_HASH_VERSION)
    // is every row written from this change onward, and adds hashVersion
    // itself plus a deterministic `details` serialization to the input so
    // that a hypothetical future v2 format could similarly coexist with v1
    // rows without invalidating them.
    if (input.hashVersion === LEGACY_HASH_VERSION) {
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

    const serializedDetails = Object.keys(input.details ?? {})
      .sort()
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
}
