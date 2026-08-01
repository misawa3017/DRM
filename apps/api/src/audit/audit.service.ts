import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AuditAction, AuditLog, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const AUDIT_CHAIN_LOCK_KEY = 727310;

interface RecordAuditEntry {
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
}

interface HashInput {
  id: string;
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
  createdAt: Date;
  prevHash: string | null;
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
      const hash = this.computeHash({ id, ...entry, createdAt, prevHash });

      return tx.auditLog.create({
        data: { id, ...entry, createdAt, prevHash, hash },
      });
    });
  }

  async verifyChain(): Promise<{ valid: boolean; brokenAtId?: string }> {
    const rows = await this.prisma.auditLog.findMany({ orderBy: { sequence: 'asc' } });
    let expectedPrevHash: string | null = null;

    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAtId: row.id };
      }
      const recomputed = this.computeHash({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
        prevHash: row.prevHash,
      });
      if (recomputed !== row.hash) {
        return { valid: false, brokenAtId: row.id };
      }
      expectedPrevHash = row.hash;
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
}
