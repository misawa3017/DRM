import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly audit: AuditService,
  ) {}

  // Application-level check rather than a DB @@unique([parentId, name]):
  // parentId is nullable (multiple root folders), and Postgres treats every
  // NULL as distinct from every other NULL, so a naive unique index would
  // silently fail to catch root-level name collisions. A soft-deleted
  // sibling's name must not block reuse, hence deletedAt: null here.
  private async assertNoFolderNameConflict(
    parentId: string | null,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const conflict = await this.prisma.folder.findFirst({
      where: {
        parentId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ConflictException('A folder with this name already exists here');
    }
  }

  async listRootFolders(user: AuthenticatedUser) {
    const folders = await this.prisma.folder.findMany({
      where: { parentId: null, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    const allowed = await Promise.all(
      folders.map((folder) => this.acl.can(user, 'folder', folder.id, 'view')),
    );
    // Not audited: this only decides which root folders are *listed*, it
    // doesn't view any one folder's contents. Opening a folder is still
    // audited as folder_view via getWithContents below, mirroring the
    // listVersions/getMetadata split in documents.service.ts.
    return folders.filter((_, index) => allowed[index]);
  }

  async create(user: AuthenticatedUser, name: string, parentId: string | null, ipAddress: string | null) {
    if (parentId === null || parentId === undefined) {
      if (!user.roles.includes('admin')) {
        throw new ForbiddenException('Only admins can create root-level folders');
      }
    } else {
      const allowed = await this.acl.can(user, 'folder', parentId, 'edit');
      if (!allowed) {
        throw new ForbiddenException('You do not have edit access to the parent folder');
      }
      const parent = await this.prisma.folder.findUnique({ where: { id: parentId } });
      if (!parent || parent.deletedAt) {
        throw new NotFoundException('Parent folder not found');
      }
    }

    await this.assertNoFolderNameConflict(parentId ?? null, name);

    const folder = await this.prisma.folder.create({
      data: { name, parentId: parentId ?? null, createdBy: user.id },
    });

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: folder.id,
      ipAddress,
    });

    return folder;
  }

  async getWithContents(user: AuthenticatedUser, id: string, ipAddress: string | null) {
    const allowed = await this.acl.can(user, 'folder', id, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this folder');
    }

    const folder = await this.prisma.folder.findUnique({
      where: { id },
      include: {
        children: { where: { deletedAt: null }, orderBy: { name: 'asc' } },
        documents: {
          where: { deletedAt: null },
          include: { currentVersion: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!folder || folder.deletedAt) {
      throw new NotFoundException('Folder not found');
    }

    // Each child's own canManage — not just the folder being viewed — so the
    // frontend can gate a rename/move/delete affordance per row. GET
    // /folders/:id/permissions requires 'manage', a higher bar than the
    // 'view' access that gets a caller into this method at all, so a caller
    // can see a child without being allowed to mutate it.
    const [canManage, childrenCanManage, documentsCanManage] = await Promise.all([
      this.acl.can(user, 'folder', id, 'manage'),
      Promise.all(folder.children.map((c) => this.acl.can(user, 'folder', c.id, 'manage'))),
      Promise.all(folder.documents.map((d) => this.acl.can(user, 'document', d.id, 'manage'))),
    ]);

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: id,
      ipAddress,
    });

    return {
      ...folder,
      canManage,
      children: folder.children.map((c, i) => ({ ...c, canManage: childrenCanManage[i] })),
      documents: folder.documents.map((d, i) => ({ ...d, canManage: documentsCanManage[i] })),
    };
  }

  // Descendants only (excludes folderId itself) — used to block moving a
  // folder into itself or into its own subtree.
  private async collectDescendantFolderIds(folderId: string): Promise<string[]> {
    const result: string[] = [];
    const queue: string[] = [folderId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const children = await this.prisma.folder.findMany({
        where: { parentId: current },
        select: { id: true },
      });
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    changes: { name?: string; parentId?: string },
    ipAddress: string | null,
  ) {
    const allowed = await this.acl.can(user, 'folder', id, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this folder');
    }

    const folder = await this.prisma.folder.findUnique({ where: { id } });
    if (!folder || folder.deletedAt) {
      throw new NotFoundException('Folder not found');
    }

    let newParentId = folder.parentId;
    if (changes.parentId !== undefined) {
      if (changes.parentId === null) {
        throw new BadRequestException('parentId cannot be null');
      }
      if (folder.parentId === null) {
        throw new BadRequestException('Cannot move a top-level folder');
      }
      const destinationAllowed = await this.acl.can(user, 'folder', changes.parentId, 'edit');
      if (!destinationAllowed) {
        throw new ForbiddenException('You do not have edit access to the destination folder');
      }
      const destination = await this.prisma.folder.findUnique({ where: { id: changes.parentId } });
      if (!destination || destination.deletedAt) {
        throw new NotFoundException('Destination folder not found');
      }
      const descendantIds = await this.collectDescendantFolderIds(id);
      if (changes.parentId === id || descendantIds.includes(changes.parentId)) {
        throw new BadRequestException(
          'Cannot move a folder into itself or one of its own descendants',
        );
      }
      newParentId = changes.parentId;
    }

    const newName = changes.name ?? folder.name;
    if (changes.name !== undefined || changes.parentId !== undefined) {
      await this.assertNoFolderNameConflict(newParentId, newName, folder.id);
    }

    const updated = await this.prisma.folder.update({
      where: { id },
      data: { name: newName, parentId: newParentId },
    });

    if (changes.name !== undefined && changes.name !== folder.name) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'folder_rename',
        resourceType: 'folder',
        resourceId: id,
        ipAddress,
        details: { oldName: folder.name, newName: changes.name },
      });
    }
    if (changes.parentId !== undefined && changes.parentId !== folder.parentId) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'folder_move',
        resourceType: 'folder',
        resourceId: id,
        ipAddress,
        details: { oldParentId: folder.parentId ?? '', newParentId: changes.parentId },
      });
    }

    return updated;
  }
}
