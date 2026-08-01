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
