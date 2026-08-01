import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { AuditService, type HashInput } from './audit.service';

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
    expect(entry.hashVersion).toBe(2);

    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('verifies rows written before hashVersion existed (hashVersion 0) using the legacy pre-versioning hash format, and still chains new v2 writes onto them', async () => {
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

    // A subsequent current-format write must still chain correctly onto the
    // legacy row.
    const next = await audit.record({
      actorId: 'user-after-legacy',
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: 'folder-legacy-test',
      ipAddress: null,
    });
    expect(next.prevHash).toBe(legacyRow.hash);
    expect(next.hashVersion).toBe(2);

    const mixedResult = await audit.verifyChain();
    expect(mixedResult.valid).toBe(true);
  });

  it('rejects a hashVersion 0 row that has been given a non-null `details` value, since v0 rows can never legitimately carry details', async () => {
    const tip = await prisma.auditLog.findFirst({ orderBy: { sequence: 'desc' } });
    const prevHash = tip?.hash ?? null;

    const id = randomUUID();
    const createdAt = new Date();
    const legacyRaw = [
      id,
      'legacy-user-2',
      'folder_view',
      'folder',
      'folder-legacy-details-test',
      '10.0.0.11',
      createdAt.toISOString(),
      prevHash ?? '',
    ].join('|');
    const legacyHash = createHash('sha256').update(legacyRaw).digest('hex');

    const legacyRow = await prisma.auditLog.create({
      data: {
        id,
        actorId: 'legacy-user-2',
        action: 'folder_view',
        resourceType: 'folder',
        resourceId: 'folder-legacy-details-test',
        ipAddress: '10.0.0.11',
        createdAt,
        prevHash,
        hash: legacyHash,
        hashVersion: 0,
      },
    });

    // Genuinely valid so far: the v0 row's stored hash still matches its
    // recomputed v0 hash (details was never part of the v0 hash input).
    const cleanResult = await audit.verifyChain();
    expect(cleanResult.valid).toBe(true);

    // An attacker with DB write access attaches `details` directly to the
    // v0 row. This does NOT change the row's hash (v0's format never
    // referenced `details`), so a naive hash-recompute-only check would
    // still call this valid -- exactly the "silently rewrite audit details
    // without breaking the chain" hole this test closes.
    await prisma.auditLog.update({
      where: { id: legacyRow.id },
      data: { details: { forged: 'true' } },
    });

    const tamperedResult = await audit.verifyChain();
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.brokenAtId).toBe(legacyRow.id);

    // Restore, same reasoning as the other tamper-detection tests.
    await prisma.auditLog.update({
      where: { id: legacyRow.id },
      data: { details: Prisma.DbNull },
    });
  });

  it('hashVersion 2 uses an injective `details` serialization, closing the v1 collision where a forged `permissionLevel` value could smuggle in a fake `principalId`', () => {
    // Under the OLD (v1) `key=value` pairs joined by `,` serialization,
    // these two DISTINCT `details` objects serialize to the IDENTICAL
    // string: `permissionLevel=view,principalId=attacker,principalType=user`.
    // The forged object's `permissionLevel` value smuggles in the literal
    // text `,principalId=attacker`, reconstructing the exact same joined
    // output as the genuine grant below. An attacker with DB write access
    // could substitute the forged `details` for the genuine one on a
    // `permission_grant` row and, under v1, verifyChain() would still
    // report the row valid -- silently erasing the record of who actually
    // received access. This test proves v2 closes that hole: it is written
    // to FAIL against the old v1 serialization (per the premise assertion
    // below, which confirms the collision is real) and PASS against the
    // new v2 serialization.
    const genuine: Record<string, string> = {
      principalType: 'user',
      principalId: 'attacker',
      permissionLevel: 'view',
    };
    const forged: Record<string, string> = {
      permissionLevel: 'view,principalId=attacker',
      principalType: 'user',
    };

    // Confirm the premise: they really do collide under the old v1
    // serialization -- this is precisely what made the original bug
    // exploitable.
    const serializeLikeV1 = (details: Record<string, string>) =>
      Object.keys(details)
        .sort()
        .map((k) => `${k}=${details[k]}`)
        .join(',');
    expect(serializeLikeV1(genuine)).toBe(serializeLikeV1(forged));

    const shared: Omit<HashInput, 'details'> = {
      hashVersion: 2,
      id: 'fixed-id-for-collision-test',
      actorId: 'actor',
      action: 'permission_grant',
      resourceType: 'folder',
      resourceId: 'resource',
      ipAddress: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      prevHash: null,
    };

    // Reach into the private computeHash to exercise the real v2 code path
    // directly, matching this file's established pattern of casting for
    // direct low-level construction (see `new AuditService(prisma as any)`
    // in beforeAll above).
    const computeHash = (
      audit as unknown as { computeHash: (input: HashInput) => string }
    ).computeHash.bind(audit);

    const genuineHash = computeHash({ ...shared, details: genuine });
    const forgedHash = computeHash({ ...shared, details: forged });

    expect(genuineHash).not.toBe(forgedHash);
  });

  it('verifies rows written under the legacy hashVersion 1 format (non-injective `details` serialization) using that format exactly, without being broken by the addition of hashVersion 2', async () => {
    const tip = await prisma.auditLog.findFirst({ orderBy: { sequence: 'desc' } });
    const prevHash = tip?.hash ?? null;

    const id = randomUUID();
    const createdAt = new Date();
    const details = { principalId: 'principal-legacy-v1', permissionLevel: 'view' };
    const serializedDetails = Object.keys(details)
      .sort()
      .map((k) => `${k}=${(details as Record<string, string>)[k]}`)
      .join(',');
    const legacyV1Raw = [
      1,
      id,
      'legacy-v1-user',
      'permission_grant',
      'folder',
      'folder-legacy-v1-test',
      '10.0.0.10',
      createdAt.toISOString(),
      prevHash ?? '',
      serializedDetails,
    ].join('|');
    const legacyV1Hash = createHash('sha256').update(legacyV1Raw).digest('hex');

    const legacyV1Row = await prisma.auditLog.create({
      data: {
        id,
        actorId: 'legacy-v1-user',
        action: 'permission_grant',
        resourceType: 'folder',
        resourceId: 'folder-legacy-v1-test',
        ipAddress: '10.0.0.10',
        createdAt,
        prevHash,
        hash: legacyV1Hash,
        hashVersion: 1,
        details,
      },
    });

    const legacyResult = await audit.verifyChain();
    expect(legacyResult.valid).toBe(true);

    // A subsequent v2 write must still chain correctly onto the legacy v1 row.
    const next = await audit.record({
      actorId: 'user-after-legacy-v1',
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: 'folder-legacy-v1-test',
      ipAddress: null,
    });
    expect(next.prevHash).toBe(legacyV1Row.hash);
    expect(next.hashVersion).toBe(2);

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
