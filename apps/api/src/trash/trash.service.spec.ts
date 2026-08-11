import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { TrashService } from './trash.service';

describe('TrashService', () => {
  const folderFindMany = jest.fn();
  const folderFindUnique = jest.fn();
  const folderUpdateMany = jest.fn();
  const folderDeleteMany = jest.fn();
  const documentFindMany = jest.fn();
  const documentFindUnique = jest.fn();
  const documentUpdate = jest.fn();
  const documentDelete = jest.fn();
  const documentDeleteMany = jest.fn();
  const documentVersionFindMany = jest.fn();
  const documentVersionDeleteMany = jest.fn();
  const permissionDeleteMany = jest.fn();
  const transaction = jest.fn();
  const deleteObjects = jest.fn();
  const recordSafely = jest.fn();

  const prisma = {
    folder: {
      findMany: folderFindMany,
      findUnique: folderFindUnique,
      updateMany: folderUpdateMany,
      deleteMany: folderDeleteMany,
    },
    document: {
      findMany: documentFindMany,
      findUnique: documentFindUnique,
      update: documentUpdate,
      delete: documentDelete,
      deleteMany: documentDeleteMany,
    },
    documentVersion: { findMany: documentVersionFindMany, deleteMany: documentVersionDeleteMany },
    permission: { deleteMany: permissionDeleteMany },
    $transaction: transaction,
  } as unknown as PrismaService;
  const storage = { deleteObjects } as unknown as StorageService;
  const audit = { recordSafely } as unknown as AuditService;
  const service = new TrashService(prisma, storage, audit);
  const user = { id: 'admin-1', roles: ['admin'] };

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.mockResolvedValue(undefined);
    deleteObjects.mockResolvedValue(undefined);
    recordSafely.mockResolvedValue(undefined);
  });

  it('合併資料夾與文件垃圾桶項目並依刪除時間排序', async () => {
    folderFindMany.mockResolvedValue([
      { id: 'folder-1', name: '舊資料夾', parentId: null, deletedAt: new Date('2026-08-01'), createdAt: new Date('2026-01-01') },
    ]);
    documentFindMany.mockResolvedValue([
      { id: 'document-1', name: '新文件.pdf', folderId: 'active-folder', deletedAt: new Date('2026-08-02'), createdAt: new Date('2026-01-02') },
    ]);

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: 'document-1', resourceType: 'document' }),
      expect.objectContaining({ id: 'folder-1', resourceType: 'folder' }),
    ]);
  });

  it('還原文件前偵測同一資料夾中的名稱衝突，且不寫入資料或稽核', async () => {
    documentFindUnique.mockResolvedValue({ id: 'document-1', name: '報告.pdf', folderId: 'folder-1', deletedAt: new Date() });
    folderFindUnique.mockResolvedValue({ deletedAt: null });
    documentFindMany.mockResolvedValueOnce([]);
    // 還原衝突查詢使用 findFirst；以動態屬性保留 Prisma mock 的實際呼叫形狀。
    (prisma.document as unknown as { findFirst: jest.Mock }).findFirst = jest.fn().mockResolvedValue({ id: 'active-document' });

    await expect(service.restoreDocument(user, 'document-1', '127.0.0.1')).rejects.toThrow(ConflictException);
    expect(documentUpdate).not.toHaveBeenCalled();
    expect(recordSafely).not.toHaveBeenCalled();
  });

  it('永久清除文件時刪除原始檔、預覽檔、關聯資料與稽核紀錄', async () => {
    documentFindUnique.mockResolvedValue({ id: 'document-1', deletedAt: new Date() });
    documentVersionFindMany.mockResolvedValue([
      { objectKey: 'objects/original', previewObjectKey: 'objects/preview' },
      { objectKey: 'objects/old-version', previewObjectKey: null },
    ]);

    await service.purgeDocument(user, 'document-1', '127.0.0.1');

    expect(deleteObjects).toHaveBeenCalledWith(['objects/original', 'objects/preview', 'objects/old-version']);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(permissionDeleteMany).toHaveBeenCalledWith({ where: { resourceType: 'document', resourceId: 'document-1' } });
    expect(documentVersionDeleteMany).toHaveBeenCalledWith({ where: { documentId: 'document-1' } });
    expect(documentDelete).toHaveBeenCalledWith({ where: { id: 'document-1' } });
    expect(recordSafely).toHaveBeenCalledWith(expect.objectContaining({
      action: 'document_purge', resourceType: 'document', resourceId: 'document-1', actorId: 'admin-1',
    }));
  });
});
