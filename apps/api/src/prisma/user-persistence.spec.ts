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

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

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

  it('enforces unique email', async () => {
    await prisma.user.create({
      data: { keycloakSub: 'dup-1', email: 'dup@example.com', displayName: 'Dup One' },
    });

    await expect(
      prisma.user.create({
        data: { keycloakSub: 'dup-2', email: 'dup@example.com', displayName: 'Dup Two' },
      }),
    ).rejects.toThrow();
  });
});
