import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
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
});
