import { Injectable } from '@nestjs/common';
import { PermissionLevel, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  view: 1,
  download: 2,
  edit: 3,
  manage: 4,
};

const MAX_FOLDER_DEPTH = 100;

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

export interface ManagedResourceRef {
  resourceType: ResourceType;
  resourceId: string;
  source: 'direct' | { inheritedFrom: { resourceId: string; resourceName: string } };
}

interface ManageOrigin {
  resourceId: string;
  resourceName: string;
}

@Injectable()
export class AclService {
  constructor(private readonly prisma: PrismaService) {}

  async can(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    required: PermissionLevel,
  ): Promise<boolean> {
    if (user.roles.includes('admin')) {
      return true;
    }
    const level = await this.resolveLevel(user.id, resourceType, resourceId);
    if (!level) {
      return false;
    }
    return LEVEL_ORDER[level] >= LEVEL_ORDER[required];
  }

  async resolveLevel(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<PermissionLevel | null> {
    if (resourceType === 'document') {
      const direct = await this.findGrant('document', resourceId, userId);
      if (direct) return direct;

      const doc = await this.prisma.document.findUnique({
        where: { id: resourceId },
        select: { folderId: true },
      });
      if (!doc) return null; // fail closed: a non-existent resource never grants access
      return this.resolveLevel(userId, 'folder', doc.folderId);
    }

    let folderId: string | null = resourceId;
    for (let depth = 0; folderId && depth < MAX_FOLDER_DEPTH; depth++) {
      const direct = await this.findGrant('folder', folderId, userId);
      if (direct) return direct;

      const folder: { parentId: string | null } | null = await this.prisma.folder.findUnique({
        where: { id: folderId },
        select: { parentId: true },
      });
      if (!folder) return null; // fail closed: a non-existent resource never grants access
      folderId = folder.parentId;
    }
    return null;
  }

  async findManagedResources(
    user: AuthenticatedUser,
    includeInherited: boolean,
  ): Promise<ManagedResourceRef[] | 'all'> {
    if (user.roles.includes('admin')) {
      return 'all';
    }

    const directGrants = await this.prisma.permission.findMany({
      where: { principalType: 'user', principalId: user.id, permissionLevel: 'manage' },
      select: { resourceType: true, resourceId: true },
    });

    const direct: ManagedResourceRef[] = directGrants.map((g) => ({
      resourceType: g.resourceType,
      resourceId: g.resourceId,
      source: 'direct',
    }));

    if (!includeInherited) {
      return direct;
    }

    const expanded: ManagedResourceRef[] = [...direct];
    for (const seed of directGrants) {
      if (seed.resourceType !== 'folder') continue;
      const seedFolder = await this.prisma.folder.findUnique({
        where: { id: seed.resourceId },
        select: { name: true },
      });
      if (!seedFolder) continue;
      await this.walkFolderForManagedDescendants(
        user.id,
        seed.resourceId,
        'manage',
        { resourceId: seed.resourceId, resourceName: seedFolder.name },
        expanded,
      );
    }
    return expanded;
  }

  // Not pruned: a folder/document whose effective level falls below `manage` is excluded
  // from the results, but its own children are still walked — resolveLevel's "closest
  // explicit grant wins, does not merge levels" semantics mean a deeper descendant can
  // regain `manage` via its own independent override even under a demoted branch (see
  // acl.service.spec.ts's findManagedResources tests, especially "does not stop recursing
  // past a lower-override branch"). There is no safe early-exit; this is O(descendant
  // count) per seed folder by design — see the design doc's "範疇之外" for the accepted
  // performance trade-off.
  //
  // Two values are threaded through the recursion, and they update on different triggers:
  //  - `nearestLevel` is what a node with NO explicit grant of its own would inherit. It
  //    updates on ANY explicit grant found on a node, regardless of level — a node's own
  //    `view` grant, say, cuts off `manage` inheritance for its no-grant descendants just as
  //    much as a `manage` grant would replace it, per resolveLevel's "nearest wins" rule.
  //  - `nearestManageOrigin` is the closest ancestor whose OWN grant was specifically
  //    `manage`-level, and it's what gets attributed as the `inheritedFrom` source for any
  //    node whose effective level is `manage` — including a node that reaches `manage` via
  //    its OWN grant rather than by inheriting it (that node's own grant already produced a
  //    'direct' entry from the top-level query in findManagedResources; the entry pushed
  //    here during the walk describes it as also reachable via the nearest ancestor `manage`
  //    grant, so it intentionally does NOT update to point at itself for its own entry —
  //    only for entries pushed for ITS descendants). Because it only moves on `manage`-level
  //    grants, an intervening lower-level grant (like `middle`'s `view` in the "does not stop
  //    recursing" test) does not shift it, which is what lets a `manage`-reachable grandchild
  //    past that branch still be attributed to the original `manage` ancestor above `middle`.
  private async walkFolderForManagedDescendants(
    userId: string,
    folderId: string,
    nearestLevel: PermissionLevel,
    nearestManageOrigin: ManageOrigin,
    results: ManagedResourceRef[],
  ): Promise<void> {
    const [childFolders, documents] = await Promise.all([
      this.prisma.folder.findMany({ where: { parentId: folderId } }),
      this.prisma.document.findMany({ where: { folderId } }),
    ]);

    for (const child of childFolders) {
      const ownLevel = await this.findGrant('folder', child.id, userId);
      const effectiveLevel = ownLevel ?? nearestLevel;
      if (effectiveLevel === 'manage') {
        results.push({
          resourceType: 'folder',
          resourceId: child.id,
          source: { inheritedFrom: nearestManageOrigin },
        });
      }
      const nextManageOrigin: ManageOrigin =
        ownLevel === 'manage'
          ? { resourceId: child.id, resourceName: child.name }
          : nearestManageOrigin;
      await this.walkFolderForManagedDescendants(
        userId,
        child.id,
        effectiveLevel,
        nextManageOrigin,
        results,
      );
    }

    for (const doc of documents) {
      const ownLevel = await this.findGrant('document', doc.id, userId);
      const effectiveLevel = ownLevel ?? nearestLevel;
      if (effectiveLevel === 'manage') {
        results.push({
          resourceType: 'document',
          resourceId: doc.id,
          source: { inheritedFrom: nearestManageOrigin },
        });
      }
    }
  }

  private async findGrant(
    resourceType: ResourceType,
    resourceId: string,
    userId: string,
  ): Promise<PermissionLevel | null> {
    const permission = await this.prisma.permission.findUnique({
      where: {
        resourceType_resourceId_principalType_principalId: {
          resourceType,
          resourceId,
          principalType: 'user',
          principalId: userId,
        },
      },
    });
    return permission?.permissionLevel ?? null;
  }
}
