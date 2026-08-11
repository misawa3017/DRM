import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';
import { FoldersService } from './folders.service';

describe('FoldersService', () => {
  const folderFindUnique = jest.fn();
  const folderFindMany = jest.fn();
  const folderFindFirst = jest.fn();
  const folderUpdate = jest.fn();
  const permissionFindMany = jest.fn();
  const userFindMany = jest.fn();
  const resolveEffectiveLevel = jest.fn();
  const can = jest.fn();
  const recordSafely = jest.fn();

  const prisma = {
    folder: {
      findUnique: folderFindUnique,
      findMany: folderFindMany,
      findFirst: folderFindFirst,
      update: folderUpdate,
    },
    permission: { findMany: permissionFindMany },
    user: { findMany: userFindMany },
  } as unknown as PrismaService;
  const acl = { resolveEffectiveLevel, can } as unknown as AclService;
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
    can.mockResolvedValue(true);
    folderFindFirst.mockResolvedValue(null);
    folderUpdate.mockResolvedValue({ id: 'folder-1', name: '目前資料夾', parentId: 'parent-1' });
  });

  it('以單次權限查詢篩選可見的頂層資料夾', async () => {
    folderFindMany.mockResolvedValue([
      { id: 'folder-view', name: '可檢視' },
      { id: 'folder-none', name: '不可檢視' },
      { id: 'folder-manage', name: '可管理' },
    ]);
    permissionFindMany.mockResolvedValue([
      { resourceId: 'folder-view', permissionLevel: 'view' },
      { resourceId: 'folder-manage', permissionLevel: 'manage' },
    ]);

    await expect(service.listRootFolders(user)).resolves.toEqual([
      { id: 'folder-view', name: '可檢視' },
      { id: 'folder-manage', name: '可管理' },
    ]);
    expect(permissionFindMany).toHaveBeenCalledTimes(1);
    expect(resolveEffectiveLevel).not.toHaveBeenCalled();
  });

  it('管理員列出頂層資料夾時不需要查詢個別權限', async () => {
    folderFindMany.mockResolvedValue([{ id: 'folder-1', name: '頂層資料夾' }]);

    await expect(service.listRootFolders({ id: 'admin-1', roles: ['admin'] })).resolves.toEqual([
      { id: 'folder-1', name: '頂層資料夾' },
    ]);
    expect(permissionFindMany).not.toHaveBeenCalled();
  });

  it('getWithContents 每個資源只解析一次權限，並從同一等級計算操作能力', async () => {
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

  it('重新命名時保留父資料夾並記錄重新命名稽核', async () => {
    folderFindUnique.mockResolvedValue({
      id: 'folder-1',
      name: '舊名稱',
      parentId: 'parent-1',
      deletedAt: null,
    });
    folderUpdate.mockResolvedValue({ id: 'folder-1', name: '新名稱', parentId: 'parent-1' });

    await expect(service.update(user, 'folder-1', { name: '新名稱' }, '127.0.0.1')).resolves.toEqual({
      id: 'folder-1',
      name: '新名稱',
      parentId: 'parent-1',
    });

    expect(recordSafely).toHaveBeenCalledWith(expect.objectContaining({
      action: 'folder_rename',
      details: { oldName: '舊名稱', newName: '新名稱' },
    }));
  });

  it('移動時驗證目的地、排除子樹並記錄移動稽核', async () => {
    folderFindUnique
      .mockResolvedValueOnce({ id: 'folder-1', name: '目前資料夾', parentId: 'parent-1', deletedAt: null })
      .mockResolvedValueOnce({ id: 'destination-1', name: '目的地', parentId: 'parent-2', deletedAt: null });
    folderFindMany.mockResolvedValue([]);
    folderUpdate.mockResolvedValue({ id: 'folder-1', name: '目前資料夾', parentId: 'destination-1' });

    await service.update(user, 'folder-1', { parentId: 'destination-1' }, null);

    expect(can).toHaveBeenNthCalledWith(1, user, 'folder', 'folder-1', 'edit');
    expect(can).toHaveBeenNthCalledWith(2, user, 'folder', 'destination-1', 'edit');
    expect(folderUpdate).toHaveBeenCalledWith({
      where: { id: 'folder-1' },
      data: { name: '目前資料夾', parentId: 'destination-1' },
    });
    expect(recordSafely).toHaveBeenCalledWith(expect.objectContaining({
      action: 'folder_move',
      details: { oldParentId: 'parent-1', newParentId: 'destination-1' },
    }));
  });
});
