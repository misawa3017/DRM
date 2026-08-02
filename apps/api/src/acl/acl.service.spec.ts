import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { AclService } from './acl.service';

describe('AclService', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let acl: AclService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- test-only bridge between the raw PrismaClient (test infra) and PrismaService (Nest-injected in production)
    acl = new AclService(prisma as any);
  }, 60000);

  // See user-persistence.spec.ts's afterAll for why this needs an explicit
  // timeout matching beforeAll's: container.stop() genuinely exceeded
  // Jest's default 5000ms hook timeout under this host's real memory/swap
  // pressure during Phase 4B Task 6's combined-suite run.
  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  }, 60000);

  async function makeFolder(name: string, parentId: string | null = null) {
    return prisma.folder.create({ data: { name, parentId, createdBy: 'seed' } });
  }

  async function makeDocument(folderId: string, name: string) {
    return prisma.document.create({ data: { folderId, name, createdBy: 'seed' } });
  }

  async function grant(
    resourceType: 'folder' | 'document',
    resourceId: string,
    userId: string,
    level: 'view' | 'download' | 'edit' | 'manage',
  ) {
    return prisma.permission.create({
      data: {
        resourceType,
        resourceId,
        principalType: 'user',
        principalId: userId,
        permissionLevel: level,
        grantedBy: 'seed',
      },
    });
  }

  it('denies access when there is no grant anywhere in the chain', async () => {
    const root = await makeFolder('root-1');
    const result = await acl.can({ id: 'user-a', roles: ['employee'] }, 'folder', root.id, 'view');
    expect(result).toBe(false);
  });

  it('allows access via a direct grant on the resource', async () => {
    const root = await makeFolder('root-2');
    await grant('folder', root.id, 'user-b', 'view');
    const result = await acl.can({ id: 'user-b', roles: ['employee'] }, 'folder', root.id, 'view');
    expect(result).toBe(true);
  });

  it('inherits a grant from a parent folder when the child has no explicit ACL', async () => {
    const root = await makeFolder('root-3');
    const child = await makeFolder('child-3', root.id);
    const doc = await makeDocument(child.id, 'doc-3');
    await grant('folder', root.id, 'user-c', 'edit');

    const result = await acl.can({ id: 'user-c', roles: ['employee'] }, 'document', doc.id, 'edit');
    expect(result).toBe(true);
  });

  it('does not merge levels: an explicit lower grant on the resource overrides a higher inherited grant', async () => {
    const root = await makeFolder('root-4');
    const doc = await makeDocument(root.id, 'doc-4');
    await grant('folder', root.id, 'user-d', 'manage');
    await grant('document', doc.id, 'user-d', 'view');

    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'view')).toBe(true);
    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'edit')).toBe(false);
  });

  it('treats permission levels as hierarchical: edit implies view and download', async () => {
    const root = await makeFolder('root-5');
    await grant('folder', root.id, 'user-e', 'edit');

    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'view')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'download')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'edit')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'manage')).toBe(false);
  });

  it('lets the admin role bypass ACL entirely, even with zero grants', async () => {
    const root = await makeFolder('root-6');
    const result = await acl.can({ id: 'user-f', roles: ['admin'] }, 'folder', root.id, 'manage');
    expect(result).toBe(true);
  });

  it('does not let deptmanager or employee roles bypass ACL', async () => {
    const root = await makeFolder('root-7');
    expect(await acl.can({ id: 'user-g', roles: ['deptmanager'] }, 'folder', root.id, 'view')).toBe(false);
  });

  it('fails closed (denies) when the resource does not exist, rather than throwing', async () => {
    const result = await acl.can(
      { id: 'user-i', roles: ['employee'] },
      'folder',
      '00000000-0000-0000-0000-000000000000',
      'view',
    );
    expect(result).toBe(false);
  });

  it('walks up multiple levels of folder nesting to find a grant', async () => {
    const root = await makeFolder('root-8');
    const mid = await makeFolder('mid-8', root.id);
    const leaf = await makeFolder('leaf-8', mid.id);
    await grant('folder', root.id, 'user-h', 'download');

    const result = await acl.can({ id: 'user-h', roles: ['employee'] }, 'folder', leaf.id, 'download');
    expect(result).toBe(true);
  });
});
