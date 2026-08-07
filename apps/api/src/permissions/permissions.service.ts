import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionLevel, PrincipalType, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AclService, type ManagedResourceRef } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly audit: AuditService,
  ) {}

  async grant(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionLevel: PermissionLevel,
    ipAddress: string | null,
  ) {
    if (principalType === 'group') {
      throw new BadRequestException('group principals are not yet supported');
    }

    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }

    const permission = await this.prisma.permission.upsert({
      where: {
        resourceType_resourceId_principalType_principalId: {
          resourceType,
          resourceId,
          principalType,
          principalId,
        },
      },
      update: { permissionLevel, grantedBy: user.id },
      create: {
        resourceType,
        resourceId,
        principalType,
        principalId,
        permissionLevel,
        grantedBy: user.id,
      },
    });

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'permission_grant',
      resourceType,
      resourceId,
      ipAddress,
      details: { principalType, principalId, permissionLevel },
    });

    return permission;
  }

  async list(user: AuthenticatedUser, resourceType: ResourceType, resourceId: string) {
    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }
    const permissions = await this.prisma.permission.findMany({ where: { resourceType, resourceId } });
    return Promise.all(permissions.map((p) => this.enrichWithPrincipal(p)));
  }

  async listGlobal(user: AuthenticatedUser, includeInherited: boolean) {
    const managed = await this.acl.findManagedResources(user, includeInherited);

    if (managed !== 'all' && managed.length === 0) {
      return [];
    }

    const permissionWhere =
      managed === 'all'
        ? {}
        : { OR: managed.map((m) => ({ resourceType: m.resourceType, resourceId: m.resourceId })) };

    const permissions = await this.prisma.permission.findMany({ where: permissionWhere });

    const sourceByResource = new Map<string, ManagedResourceRef['source']>();
    if (managed !== 'all') {
      for (const m of managed) {
        sourceByResource.set(`${m.resourceType}:${m.resourceId}`, m.source);
      }
    }

    return Promise.all(
      permissions.map(async (p) => {
        const enriched = await this.enrichWithPrincipal(p);
        const resource = await this.resolveResourcePath(p.resourceType, p.resourceId);
        return {
          ...enriched,
          resourceName: resource?.name ?? '(已刪除)',
          resourcePath: resource?.path ?? '',
          // The `?? 'direct'` below is unreachable given permissionWhere's OR scoping
          // above (every row `permissions` can contain already has a matching key in
          // sourceByResource, since that filter is built directly from the same `managed`
          // array); defaulting to 'direct' rather than throwing keeps listGlobal resilient
          // if that invariant is ever broken by a future refactor.
          source:
            managed === 'all'
              ? 'direct'
              : (sourceByResource.get(`${p.resourceType}:${p.resourceId}`) ?? 'direct'),
        };
      }),
    );
  }

  private async resolveResourcePath(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<{ name: string; path: string } | null> {
    if (resourceType === 'document') {
      const doc = await this.prisma.document.findUnique({
        where: { id: resourceId },
        select: { name: true, folderId: true },
      });
      if (!doc) return null;
      return { name: doc.name, path: await this.resolveFolderPath(doc.folderId) };
    }
    const folder = await this.prisma.folder.findUnique({
      where: { id: resourceId },
      select: { name: true, parentId: true },
    });
    if (!folder) return null;
    return { name: folder.name, path: await this.resolveFolderPath(folder.parentId) };
  }

  private async resolveFolderPath(folderId: string | null): Promise<string> {
    const names: string[] = [];
    let currentId = folderId;
    for (let depth = 0; currentId && depth < 100; depth++) {
      const folder: { name: string; parentId: string | null } | null =
        await this.prisma.folder.findUnique({
          where: { id: currentId },
          select: { name: true, parentId: true },
        });
      if (!folder) break;
      names.unshift(folder.name);
      currentId = folder.parentId;
    }
    return ['Root', ...names].join(' / ');
  }

  private async enrichWithPrincipal<T extends { principalType: PrincipalType; principalId: string }>(
    permission: T,
  ): Promise<T & { principal: { email: string; displayName: string } | null }> {
    if (permission.principalType !== 'user') {
      return { ...permission, principal: null };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: permission.principalId },
      select: { email: true, displayName: true },
    });
    return { ...permission, principal: user ?? null };
  }

  async revoke(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    permissionId: string,
    ipAddress: string | null,
  ) {
    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }
    // Fetch (scoped by the exact same id + resourceType + resourceId as the
    // delete below) before deleting, purely to capture what's about to be
    // deleted for the audit entry — deleteMany doesn't return row content.
    // This does NOT weaken the authorization scoping: the delete itself is
    // still a single scoped deleteMany with the same compound where-clause,
    // and existence/success is still determined from its own `count`, not
    // from this preceding read (so there's no TOCTOU gap — a row that
    // disappears between the two calls just yields count === 0, same as
    // today).
    const toDelete = await this.prisma.permission.findFirst({
      where: { id: permissionId, resourceType, resourceId },
    });

    const { count } = await this.prisma.permission.deleteMany({
      where: { id: permissionId, resourceType, resourceId },
    });
    if (count === 0) {
      throw new NotFoundException('Permission not found');
    }

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'permission_revoke',
      resourceType,
      resourceId,
      ipAddress,
      details: toDelete
        ? { principalId: toDelete.principalId, permissionLevel: toDelete.permissionLevel }
        : undefined,
    });
  }
}
