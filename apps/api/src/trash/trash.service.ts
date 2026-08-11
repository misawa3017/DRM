import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class TrashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const [folders, documents] = await Promise.all([
      this.prisma.folder.findMany({
        // Child folders are restored/purged with their deleted ancestor, so
        // show only the root entry to prevent duplicate destructive actions.
        where: {
          deletedAt: { not: null },
          OR: [{ parentId: null }, { parent: { is: { deletedAt: null } } }],
        },
        select: { id: true, name: true, parentId: true, deletedAt: true, createdAt: true },
        orderBy: { deletedAt: 'desc' },
      }),
      this.prisma.document.findMany({
        // A document below a deleted folder belongs to that folder's one
        // trash entry and must not be independently restored or purged.
        where: { deletedAt: { not: null }, folder: { is: { deletedAt: null } } },
        select: { id: true, name: true, folderId: true, deletedAt: true, createdAt: true },
        orderBy: { deletedAt: 'desc' },
      }),
    ]);
    return [
      ...folders.map((folder) => ({ ...folder, resourceType: 'folder' as const })),
      ...documents.map((document) => ({ ...document, resourceType: 'document' as const })),
    ].sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0));
  }

  private async collectFolderSubtreeIds(rootFolderId: string) {
    const folderIds = [rootFolderId];
    const documentIds: string[] = [];
    const queue = [rootFolderId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const [children, documents] = await Promise.all([
        this.prisma.folder.findMany({ where: { parentId: current }, select: { id: true } }),
        this.prisma.document.findMany({ where: { folderId: current }, select: { id: true } }),
      ]);
      for (const child of children) {
        folderIds.push(child.id);
        queue.push(child.id);
      }
      documentIds.push(...documents.map((document) => document.id));
    }
    return { folderIds, documentIds };
  }

  private async assertFolderIsInTrash(folderIds: string[]) {
    const folders = await this.prisma.folder.findMany({
      where: { id: { in: folderIds } },
      select: { id: true, name: true, parentId: true, deletedAt: true },
    });
    if (folders.length !== folderIds.length || folders.some((folder) => !folder.deletedAt)) {
      throw new NotFoundException('Folder is not in the trash');
    }
    return folders;
  }

  private async assertFolderRestoreIsSafe(folderIds: string[], rootFolderId: string) {
    const folders = await this.assertFolderIsInTrash(folderIds);
    const restoringIds = new Set(folderIds);
    for (const folder of folders) {
      if (folder.id === rootFolderId && folder.parentId) {
        const parent = await this.prisma.folder.findUnique({
          where: { id: folder.parentId },
          select: { deletedAt: true },
        });
        if (!parent || parent.deletedAt) throw new ConflictException('Restore the parent folder first');
      }
      if (folder.parentId && !restoringIds.has(folder.parentId)) continue;
      const conflict = await this.prisma.folder.findFirst({
        where: { parentId: folder.parentId, name: folder.name, deletedAt: null },
        select: { id: true },
      });
      if (conflict) throw new ConflictException(`A folder named "${folder.name}" already exists here`);
    }
  }

  private async getDocumentInTrash(documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || !document.deletedAt) throw new NotFoundException('Document is not in the trash');
    return document;
  }

  private async assertDocumentRestoreIsSafe(documentId: string) {
    const document = await this.getDocumentInTrash(documentId);
    const parent = await this.prisma.folder.findUnique({
      where: { id: document.folderId },
      select: { deletedAt: true },
    });
    if (!parent || parent.deletedAt) throw new ConflictException('Restore the parent folder first');
    const conflict = await this.prisma.document.findFirst({
      where: { folderId: document.folderId, name: document.name, deletedAt: null },
      select: { id: true },
    });
    if (conflict) throw new ConflictException(`A document named "${document.name}" already exists here`);
    return document;
  }

  async restoreFolder(user: AuthenticatedUser, id: string, ipAddress: string | null) {
    const { folderIds, documentIds } = await this.collectFolderSubtreeIds(id);
    await this.assertFolderRestoreIsSafe(folderIds, id);
    await this.prisma.$transaction([
      this.prisma.folder.updateMany({ where: { id: { in: folderIds } }, data: { deletedAt: null } }),
      this.prisma.document.updateMany({ where: { id: { in: documentIds } }, data: { deletedAt: null } }),
    ]);
    await Promise.all([
      ...folderIds.map((resourceId) => this.audit.recordSafely({ actorId: user.id, action: 'folder_restore' as AuditAction, resourceType: 'folder', resourceId, ipAddress })),
      ...documentIds.map((resourceId) => this.audit.recordSafely({ actorId: user.id, action: 'document_restore' as AuditAction, resourceType: 'document', resourceId, ipAddress })),
    ]);
  }

  async restoreDocument(user: AuthenticatedUser, id: string, ipAddress: string | null) {
    await this.assertDocumentRestoreIsSafe(id);
    await this.prisma.document.update({ where: { id }, data: { deletedAt: null } });
    await this.audit.recordSafely({ actorId: user.id, action: 'document_restore' as AuditAction, resourceType: 'document', resourceId: id, ipAddress });
  }

  async purgeFolder(user: AuthenticatedUser, id: string, ipAddress: string | null) {
    const { folderIds, documentIds } = await this.collectFolderSubtreeIds(id);
    await this.assertFolderIsInTrash(folderIds);
    const versions = await this.prisma.documentVersion.findMany({
      where: { documentId: { in: documentIds } },
      select: { objectKey: true, previewObjectKey: true },
    });
    await this.storage.deleteObjects(versions.flatMap((version) => [version.objectKey, ...(version.previewObjectKey ? [version.previewObjectKey] : [])]));
    await this.prisma.$transaction([
      this.prisma.permission.deleteMany({ where: { OR: [ { resourceType: 'folder', resourceId: { in: folderIds } }, { resourceType: 'document', resourceId: { in: documentIds } } ] } }),
      this.prisma.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } }),
      this.prisma.document.deleteMany({ where: { id: { in: documentIds } } }),
      this.prisma.folder.deleteMany({ where: { id: { in: folderIds } } }),
    ]);
    await Promise.all([
      ...folderIds.map((resourceId) => this.audit.recordSafely({ actorId: user.id, action: 'folder_purge' as AuditAction, resourceType: 'folder', resourceId, ipAddress })),
      ...documentIds.map((resourceId) => this.audit.recordSafely({ actorId: user.id, action: 'document_purge' as AuditAction, resourceType: 'document', resourceId, ipAddress })),
    ]);
  }

  async purgeDocument(user: AuthenticatedUser, id: string, ipAddress: string | null) {
    const document = await this.getDocumentInTrash(id);
    const versions = await this.prisma.documentVersion.findMany({ where: { documentId: id }, select: { objectKey: true, previewObjectKey: true } });
    await this.storage.deleteObjects(versions.flatMap((version) => [version.objectKey, ...(version.previewObjectKey ? [version.previewObjectKey] : [])]));
    await this.prisma.$transaction([
      this.prisma.permission.deleteMany({ where: { resourceType: 'document', resourceId: id } }),
      this.prisma.documentVersion.deleteMany({ where: { documentId: id } }),
      this.prisma.document.delete({ where: { id } }),
    ]);
    await this.audit.recordSafely({ actorId: user.id, action: 'document_purge' as AuditAction, resourceType: 'document', resourceId: document.id, ipAddress });
  }
}
