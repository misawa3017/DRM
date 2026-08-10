import { GoneException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';
import { DocumentPolicyService } from './document-policy.service';

describe('DocumentPolicyService', () => {
  const documentFindUnique = jest.fn();
  const folderFindUnique = jest.fn();
  const documentFindMany = jest.fn();
  const documentUpdateMany = jest.fn();
  const recordSafely = jest.fn();
  const can = jest.fn();

  const prisma = {
    document: {
      findUnique: documentFindUnique,
      findMany: documentFindMany,
      updateMany: documentUpdateMany,
    },
    folder: { findUnique: folderFindUnique },
  } as unknown as PrismaService;
  const acl = { can } as unknown as AclService;
  const audit = { recordSafely } as unknown as AuditService;
  const service = new DocumentPolicyService(prisma, acl, audit);

  beforeEach(() => jest.clearAllMocks());

  it('文件設定優先於資料夾繼承', async () => {
    documentFindUnique.mockResolvedValue({ watermarkEnabled: false, folderId: 'folder-1' });
    await expect(service.resolveWatermarkEnabled('document-1')).resolves.toBe(false);
    expect(folderFindUnique).not.toHaveBeenCalled();
  });

  it('沿資料夾向上解析第一個明確設定', async () => {
    documentFindUnique.mockResolvedValue({ watermarkEnabled: null, folderId: 'child' });
    folderFindUnique
      .mockResolvedValueOnce({ watermarkEnabled: null, parentId: 'parent' })
      .mockResolvedValueOnce({ watermarkEnabled: false, parentId: null });
    await expect(service.resolveWatermarkEnabled('document-1')).resolves.toBe(false);
  });

  it('沒有任何明確設定時預設啟用浮水印', async () => {
    documentFindUnique.mockResolvedValue({ watermarkEnabled: null, folderId: 'folder-1' });
    folderFindUnique.mockResolvedValue({ watermarkEnabled: null, parentId: null });
    await expect(service.resolveWatermarkEnabled('document-1')).resolves.toBe(true);
  });

  it('拒絕存取已到期文件', () => {
    expect(() => service.assertActive({ status: 'expired' })).toThrow(GoneException);
  });

  it('到期掃描只為成功轉換的文件寫入稽核', async () => {
    documentFindMany.mockResolvedValue([{ id: 'document-1' }, { id: 'document-2' }]);
    documentUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(service.expireDocuments(new Date('2026-08-10T00:00:00Z'))).resolves.toBe(1);
    expect(recordSafely).toHaveBeenCalledTimes(1);
    expect(recordSafely).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document_expired', resourceId: 'document-1' }),
    );
  });
});
