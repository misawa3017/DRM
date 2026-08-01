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

    await this.audit.record({
      actorId: user.id,
      action: 'permission_grant',
      resourceType,
      resourceId,
      ipAddress,
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
    const { count } = await this.prisma.permission.deleteMany({
      where: { id: permissionId, resourceType, resourceId },
    });
    if (count === 0) {
      throw new NotFoundException('Permission not found');
    }

    await this.audit.record({
      actorId: user.id,
      action: 'permission_revoke',
      resourceType,
      resourceId,
      ipAddress,
    });
  }
}
