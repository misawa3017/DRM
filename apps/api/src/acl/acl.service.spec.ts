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

    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'view')).toBe(
      true,
    );
    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'edit')).toBe(
      false,
    );
  });

  it('treats permission levels as hierarchical: edit implies view and download', async () => {
    const root = await makeFolder('root-5');
    await grant('folder', root.id, 'user-e', 'edit');

    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'view')).toBe(
      true,
    );
    expect(
      await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'download'),
    ).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'edit')).toBe(
      true,
    );
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'manage')).toBe(
      false,
    );
  });

  it('lets the admin role bypass ACL entirely, even with zero grants', async () => {
    const root = await makeFolder('root-6');
    const result = await acl.can({ id: 'user-f', roles: ['admin'] }, 'folder', root.id, 'manage');
    expect(result).toBe(true);
  });

  it('does not let deptmanager or employee roles bypass ACL', async () => {
    const root = await makeFolder('root-7');
    expect(await acl.can({ id: 'user-g', roles: ['deptmanager'] }, 'folder', root.id, 'view')).toBe(
      false,
    );
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

  it('fails closed when a resource has been soft-deleted, even if it has a direct grant', async () => {
    const folder = await makeFolder('deleted-acl-folder');
    await grant('folder', folder.id, 'user-deleted-acl', 'manage');
    await prisma.folder.update({ where: { id: folder.id }, data: { deletedAt: new Date() } });

    expect(
      await acl.can({ id: 'user-deleted-acl', roles: ['employee'] }, 'folder', folder.id, 'view'),
    ).toBe(false);
  });

  it('walks up multiple levels of folder nesting to find a grant', async () => {
    const root = await makeFolder('root-8');
    const mid = await makeFolder('mid-8', root.id);
    const leaf = await makeFolder('leaf-8', mid.id);
    await grant('folder', root.id, 'user-h', 'download');

    const result = await acl.can(
      { id: 'user-h', roles: ['employee'] },
      'folder',
      leaf.id,
      'download',
    );
    expect(result).toBe(true);
  });

  describe('findManagedResources', () => {
    it('returns only directly-managed resources when includeInherited is false', async () => {
      const managed = await makeFolder('fmr-managed-1');
      const notManaged = await makeFolder('fmr-not-managed-1');
      await grant('folder', managed.id, 'user-fmr1', 'manage');
      await grant('folder', notManaged.id, 'user-fmr1', 'view');

      const result = await acl.findManagedResources(
        { id: 'user-fmr1', roles: ['employee'] },
        false,
      );

      expect(result).not.toBe('all');
      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toEqual([{ resourceType: 'folder', resourceId: managed.id, source: 'direct' }]);
    });

    it("'admin' role returns 'all' regardless of includeInherited", async () => {
      const result = await acl.findManagedResources({ id: 'user-fmr2', roles: ['admin'] }, false);
      expect(result).toBe('all');
      const resultInherited = await acl.findManagedResources(
        { id: 'user-fmr2', roles: ['admin'] },
        true,
      );
      expect(resultInherited).toBe('all');
    });

    it('includeInherited=true includes a child folder with no override, tagged as inherited', async () => {
      const parent = await makeFolder('fmr-parent-3');
      const child = await makeFolder('fmr-child-3', parent.id);
      await grant('folder', parent.id, 'user-fmr3', 'manage');

      const result = await acl.findManagedResources({ id: 'user-fmr3', roles: ['employee'] }, true);

      expect(result).not.toBe('all');
      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toContainEqual({
        resourceType: 'folder',
        resourceId: child.id,
        source: { inheritedFrom: { resourceId: parent.id, resourceName: 'fmr-parent-3' } },
      });
    });

    it('includeInherited=true includes a document with no override, tagged as inherited', async () => {
      const parent = await makeFolder('fmr-parent-4');
      const doc = await makeDocument(parent.id, 'fmr-doc-4');
      await grant('folder', parent.id, 'user-fmr4', 'manage');

      const result = await acl.findManagedResources({ id: 'user-fmr4', roles: ['employee'] }, true);

      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toContainEqual({
        resourceType: 'document',
        resourceId: doc.id,
        source: { inheritedFrom: { resourceId: parent.id, resourceName: 'fmr-parent-4' } },
      });
    });

    it('excludes a document with its own lower-level override, and does not include it', async () => {
      const parent = await makeFolder('fmr-parent-5');
      const doc = await makeDocument(parent.id, 'fmr-doc-5');
      await grant('folder', parent.id, 'user-fmr5', 'manage');
      await grant('document', doc.id, 'user-fmr5', 'view');

      const result = await acl.findManagedResources({ id: 'user-fmr5', roles: ['employee'] }, true);

      const refs = result as { resourceType: string; resourceId: string }[];
      expect(refs.some((r) => r.resourceId === doc.id)).toBe(false);
    });

    it(
      'does not stop recursing past a lower-override branch: a grandchild with its own manage ' +
        'grant is still included exactly once, tagged direct (not duplicated as inherited)',
      async () => {
        const parent = await makeFolder('fmr-parent-6');
        const middle = await makeFolder('fmr-middle-6', parent.id);
        const grandchild = await makeFolder('fmr-grandchild-6', middle.id);
        await grant('folder', parent.id, 'user-fmr6', 'manage');
        await grant('folder', middle.id, 'user-fmr6', 'view'); // cuts off inheritance at `middle`
        await grant('folder', grandchild.id, 'user-fmr6', 'manage'); // but regains it here

        const result = await acl.findManagedResources(
          { id: 'user-fmr6', roles: ['employee'] },
          true,
        );

        const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
        // middle itself is not manage-level, so it's excluded
        expect(refs.some((r) => r.resourceId === middle.id)).toBe(false);
        // grandchild's own direct manage grant means recursion must not have stopped at
        // `middle` — but it must appear exactly once, tagged 'direct' (its own grant), not a
        // second time as inheritedFrom some ancestor: that would be a contradictory duplicate
        // of the same resourceId, which Task 4's Map-collapse (last entry wins) would resolve
        // to the wrong tag.
        const grandchildRefs = refs.filter((r) => r.resourceId === grandchild.id);
        expect(grandchildRefs).toEqual([
          { resourceType: 'folder', resourceId: grandchild.id, source: 'direct' },
        ]);
      },
    );

    it('a child folder with its own manage override becomes the new inheritance source for its own children', async () => {
      const parent = await makeFolder('fmr-parent-7');
      const child = await makeFolder('fmr-child-7', parent.id);
      const grandchild = await makeFolder('fmr-grandchild-7', child.id);
      await grant('folder', parent.id, 'user-fmr7', 'manage');
      await grant('folder', child.id, 'user-fmr7', 'manage'); // own explicit grant, same level

      const result = await acl.findManagedResources({ id: 'user-fmr7', roles: ['employee'] }, true);

      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toContainEqual({
        resourceType: 'folder',
        resourceId: grandchild.id,
        source: { inheritedFrom: { resourceId: child.id, resourceName: 'fmr-child-7' } },
      });
    });

    it('does not duplicate a resource that has both an ancestor manage grant and its own direct manage grant', async () => {
      const parent = await makeFolder('fmr-parent-8');
      const child = await makeFolder('fmr-child-8', parent.id);
      await grant('folder', parent.id, 'user-fmr8', 'manage');
      await grant('folder', child.id, 'user-fmr8', 'manage');

      const result = await acl.findManagedResources({ id: 'user-fmr8', roles: ['employee'] }, true);

      expect(result).not.toBe('all');
      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      const childRefs = refs.filter((r) => r.resourceId === child.id);
      expect(childRefs).toEqual([
        { resourceType: 'folder', resourceId: child.id, source: 'direct' },
      ]);
    });

    it('excludes soft-deleted direct grants and descendants', async () => {
      const parent = await makeFolder('fmr-active-parent');
      const deletedChild = await makeFolder('fmr-deleted-child', parent.id);
      const deletedDocument = await makeDocument(parent.id, 'fmr-deleted-document');
      await grant('folder', parent.id, 'user-fmr-deleted', 'manage');
      await grant('folder', deletedChild.id, 'user-fmr-deleted', 'manage');
      await prisma.folder.update({
        where: { id: deletedChild.id },
        data: { deletedAt: new Date() },
      });
      await prisma.document.update({
        where: { id: deletedDocument.id },
        data: { deletedAt: new Date() },
      });

      const result = await acl.findManagedResources(
        { id: 'user-fmr-deleted', roles: ['employee'] },
        true,
      );

      const refs = result as { resourceType: string; resourceId: string }[];
      expect(refs.some((ref) => ref.resourceId === deletedChild.id)).toBe(false);
      expect(refs.some((ref) => ref.resourceId === deletedDocument.id)).toBe(false);
      expect(refs.some((ref) => ref.resourceId === parent.id)).toBe(true);
    });
  });
});
