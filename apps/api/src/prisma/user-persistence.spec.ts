import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';

describe('User persistence', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
  }, 60000);

  // Explicit timeout, matching beforeAll's: container.stop() is a real
  // Docker operation and Jest's default 5000ms hook timeout proved too
  // tight for it under this host's real memory/swap pressure during Phase
  // 4B Task 6's combined-suite run (confirmed via a genuine "Exceeded
  // timeout of 5000 ms for a hook" failure here, not hypothetical) -- the
  // same underlying resource constraint that already justified beforeAll's
  // 60000ms budget for the container's *start*.
  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  }, 60000);

  it('creates and retrieves a user', async () => {
    const created = await prisma.user.create({
      data: {
        keycloakSub: 'abc-123',
        email: 'jane@example.com',
        displayName: 'Jane Doe',
      },
    });

    const found = await prisma.user.findUnique({ where: { id: created.id } });
    expect(found?.email).toBe('jane@example.com');
  });

  it('allows two distinct users (different keycloakSub) to share the same email', async () => {
    // Keycloak brokers both Google and Microsoft as identity providers, so two
    // separate brokered identities (or an old vs. re-provisioned account) can
    // plausibly carry the same email address. keycloakSub is the stable identity
    // anchor; email is not a uniqueness constraint at the DB level.
    const first = await prisma.user.create({
      data: {
        keycloakSub: 'shared-email-1',
        email: 'shared@example.com',
        displayName: 'Shared One',
      },
    });

    const second = await prisma.user.create({
      data: {
        keycloakSub: 'shared-email-2',
        email: 'shared@example.com',
        displayName: 'Shared Two',
      },
    });

    expect(first.id).not.toBe(second.id);
    expect(first.email).toBe('shared@example.com');
    expect(second.email).toBe('shared@example.com');
  });

  it('still enforces unique keycloakSub', async () => {
    await prisma.user.create({
      data: { keycloakSub: 'dup-sub', email: 'one@example.com', displayName: 'Sub One' },
    });

    await expect(
      prisma.user.create({
        data: { keycloakSub: 'dup-sub', email: 'two@example.com', displayName: 'Sub Two' },
      }),
    ).rejects.toThrow();
  });
});
