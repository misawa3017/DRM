import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';
import { FoldersService } from './folders.service';

describe('FoldersService.getWithContents', () => {
  const folderFindUnique = jest.fn();
  const userFindMany = jest.fn();
  const resolveEffectiveLevel = jest.fn();
  const recordSafely = jest.fn();

  const prisma = {
    folder: { findUnique: folderFindUnique },
    user: { findMany: userFindMany },
  } as unknown as PrismaService;
  const acl = { resolveEffectiveLevel } as unknown as AclService;
  const audit = { recordSafely } as unknown as AuditService;
  const service = new FoldersService(prisma, acl, audit);
  const user = { id: 'user-1', roles: ['employee'] };

  beforeEach(() => {
    jest.clearAllMocks();
    folderFindUnique.mockResolvedValue({
      id: 'folder-1',
      name: '目前資料夾',
      parentId: null,
      deletedAt: null,
      children: [{ id: 'folder-2', name: '子資料夾' }],
      documents: [
        {
          id: 'document-1',
          name: '文件.pdf',
          currentVersion: { uploadedBy: 'uploader-1' },
        },
      ],
    });
    userFindMany.mockResolvedValue([
      { id: 'uploader-1', displayName: '上傳者', email: 'uploader@example.com' },
    ]);
    resolveEffectiveLevel
      .mockResolvedValueOnce('manage')
      .mockResolvedValueOnce('edit')
      .mockResolvedValueOnce('view');
    recordSafely.mockResolvedValue(undefined);
  });

  it('每個資源只解析一次權限，並從同一等級計算操作能力', async () => {
    const result = await service.getWithContents(user, 'folder-1', null);

    expect(resolveEffectiveLevel).toHaveBeenCalledTimes(3);
    expect(resolveEffectiveLevel).toHaveBeenNthCalledWith(1, user, 'folder', 'folder-1');
    expect(resolveEffectiveLevel).toHaveBeenNthCalledWith(2, user, 'folder', 'folder-2');
    expect(resolveEffectiveLevel).toHaveBeenNthCalledWith(3, user, 'document', 'document-1');
    expect(result).toMatchObject({
      canManage: true,
      canEdit: true,
      children: [{ canManage: false, canEdit: true }],
      documents: [{ canManage: false, canEdit: false }],
    });
  });
});
