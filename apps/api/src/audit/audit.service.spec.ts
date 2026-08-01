import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let audit: AuditService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- constructing AuditService directly against a raw PrismaClient for the test, matching this project's established AclService test pattern
    audit = new AuditService(prisma as any);
  }, 60000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it('the first entry has a null prevHash and a real hash', async () => {
    const entry = await audit.record({
      actorId: 'user-a',
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: 'folder-1',
      ipAddress: '10.0.0.1',
    });
    expect(entry.prevHash).toBeNull();
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains each subsequent entry to the previous one\'s hash', async () => {
    const first = await audit.record({
      actorId: 'user-b',
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: 'folder-2',
      ipAddress: null,
    });
    const second = await audit.record({
      actorId: 'user-b',
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: 'folder-2',
      ipAddress: null,
    });
    expect(second.prevHash).toBe(first.hash);
  });

  it('verifyChain reports valid for an untampered chain', async () => {
    await audit.record({
      actorId: 'user-c',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-1',
      ipAddress: '10.0.0.2',
    });
    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('verifyChain detects a tampered row', async () => {
    const entry = await audit.record({
      actorId: 'user-d',
      action: 'document_download',
      resourceType: 'document',
      resourceId: 'doc-2',
      ipAddress: '10.0.0.3',
    });

    await prisma.auditLog.update({
      where: { id: entry.id },
      data: { actorId: 'user-d-tampered' },
    });

    const result = await audit.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(entry.id);

    // Restore the row so this test's deliberate corruption doesn't leak into
    // later tests that call verifyChain() over the whole (shared) table.
    await prisma.auditLog.update({
      where: { id: entry.id },
      data: { actorId: 'user-d' },
    });
  });

  it('serializes concurrent writes into a single strictly linear chain', async () => {
    const concurrentWrites = Array.from({ length: 10 }, (_, i) =>
      audit.record({
        actorId: `concurrent-user-${i}`,
        action: 'folder_view',
        resourceType: 'folder',
        resourceId: 'folder-concurrent',
        ipAddress: null,
      }),
    );
    await Promise.all(concurrentWrites);

    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('listForResource returns only entries for that resource, in order', async () => {
    await audit.record({
      actorId: 'user-e',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-list-test',
      ipAddress: null,
    });
    await audit.record({
      actorId: 'user-e',
      action: 'document_download',
      resourceType: 'document',
      resourceId: 'doc-list-test',
      ipAddress: null,
    });
    await audit.record({
      actorId: 'user-e',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-unrelated',
      ipAddress: null,
    });

    const entries = await audit.listForResource('document', 'doc-list-test');
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('document_view');
    expect(entries[1].action).toBe('document_download');
  });

  it('stamps entries with the current hashVersion', async () => {
    const entry = await audit.record({
      actorId: 'user-hashversion',
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: 'folder-hashversion-test',
      ipAddress: null,
    });
    expect(entry.hashVersion).toBe(1);

    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('verifies rows written before hashVersion existed (hashVersion 0) using the legacy pre-versioning hash format, and still chains new v1 writes onto them', async () => {
    const tip = await prisma.auditLog.findFirst({ orderBy: { sequence: 'desc' } });
    const prevHash = tip?.hash ?? null;

    const id = randomUUID();
    const createdAt = new Date();
    const legacyRaw = [
      id,
      'legacy-user',
      'folder_view',
      'folder',
      'folder-legacy-test',
      '10.0.0.9',
      createdAt.toISOString(),
      prevHash ?? '',
    ].join('|');
    const legacyHash = createHash('sha256').update(legacyRaw).digest('hex');

    const legacyRow = await prisma.auditLog.create({
      data: {
        id,
        actorId: 'legacy-user',
        action: 'folder_view',
        resourceType: 'folder',
        resourceId: 'folder-legacy-test',
        ipAddress: '10.0.0.9',
        createdAt,
        prevHash,
        hash: legacyHash,
        hashVersion: 0,
      },
    });

    const legacyResult = await audit.verifyChain();
    expect(legacyResult.valid).toBe(true);

    // A subsequent v1 write must still chain correctly onto the legacy row.
    const next = await audit.record({
      actorId: 'user-after-legacy',
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: 'folder-legacy-test',
      ipAddress: null,
    });
    expect(next.prevHash).toBe(legacyRow.hash);
    expect(next.hashVersion).toBe(1);

    const mixedResult = await audit.verifyChain();
    expect(mixedResult.valid).toBe(true);
  });

  it('includes details in the hash, so tampering with details alone is detected', async () => {
    const entry = await audit.record({
      actorId: 'user-details',
      action: 'permission_grant',
      resourceType: 'folder',
      resourceId: 'folder-details-test',
      ipAddress: null,
      details: { principalId: 'principal-1', permissionLevel: 'view' },
    });
    expect(entry.details).toEqual({ principalId: 'principal-1', permissionLevel: 'view' });

    await prisma.auditLog.update({
      where: { id: entry.id },
      data: { details: { principalId: 'principal-1', permissionLevel: 'manage' } },
    });

    const tamperedResult = await audit.verifyChain();
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.brokenAtId).toBe(entry.id);

    // Restore, same reasoning as the earlier tamper-detection test.
    await prisma.auditLog.update({
      where: { id: entry.id },
      data: { details: { principalId: 'principal-1', permissionLevel: 'view' } },
    });
  });

  it('verifyChain correctly validates and detects tampering in a chain that spans multiple batches', async () => {
    const seeded = [];
    for (let i = 0; i < 7; i++) {
      seeded.push(
        await audit.record({
          actorId: `batch-user-${i}`,
          action: 'folder_view',
          resourceType: 'folder',
          resourceId: 'folder-batch-test',
          ipAddress: null,
        }),
      );
    }

    // A batchSize of 2 forces verifyChain to walk these 7 rows across at
    // least 4 pages, proving expectedPrevHash carries correctly across
    // cursor-based batch boundaries, not just within a single page.
    const validResult = await audit.verifyChain(2);
    expect(validResult.valid).toBe(true);

    // Tamper with a row several batches in, to prove detection still works
    // once the walk has already crossed at least one batch boundary.
    const target = seeded[5];
    await prisma.auditLog.update({
      where: { id: target.id },
      data: { actorId: 'batch-user-5-tampered' },
    });

    const tamperedResult = await audit.verifyChain(2);
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.brokenAtId).toBe(target.id);

    await prisma.auditLog.update({
      where: { id: target.id },
      data: { actorId: 'batch-user-5' },
    });
  });

  it('recordSafely does not throw when the underlying write fails, and logs the failure instead', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const recordSpy = jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('simulated audit write failure'));

    await expect(
      audit.recordSafely({
        actorId: 'user-f',
        action: 'folder_view',
        resourceType: 'folder',
        resourceId: 'folder-recordsafely-test',
        ipAddress: null,
      }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('Failed to write audit log entry');

    recordSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
