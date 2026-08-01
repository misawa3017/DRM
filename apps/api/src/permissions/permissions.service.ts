import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionLevel, PrincipalType, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
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
    return this.prisma.permission.findMany({ where: { resourceType, resourceId } });
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
