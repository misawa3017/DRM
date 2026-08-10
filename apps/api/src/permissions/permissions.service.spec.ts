import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from './permissions.service';

describe('PermissionsService 軟刪除整合', () => {
  const folderFindFirst = jest.fn();
  const folderFindMany = jest.fn();
  const documentFindFirst = jest.fn();
  const documentFindMany = jest.fn();
  const permissionFindMany = jest.fn();
  const permissionUpsert = jest.fn();
  const permissionFindFirst = jest.fn();
  const permissionDeleteMany = jest.fn();
  const userFindUnique = jest.fn();
  const can = jest.fn();
  const findManagedResources = jest.fn();
  const recordSafely = jest.fn();

  const prisma = {
    folder: { findFirst: folderFindFirst, findMany: folderFindMany },
    document: { findFirst: documentFindFirst, findMany: documentFindMany },
    permission: {
      findMany: permissionFindMany,
      upsert: permissionUpsert,
      findFirst: permissionFindFirst,
      deleteMany: permissionDeleteMany,
    },
    user: { findUnique: userFindUnique },
  } as unknown as PrismaService;
  const acl = { can, findManagedResources } as unknown as AclService;
  const audit = { recordSafely } as unknown as AuditService;
  const service = new PermissionsService(prisma, acl, audit);
  const admin = { id: 'admin-1', roles: ['admin'] };

  beforeEach(() => {
    jest.clearAllMocks();
    can.mockResolvedValue(true);
    folderFindFirst.mockResolvedValue(null);
    documentFindFirst.mockResolvedValue(null);
  });

  it('已刪除資源即使由管理員操作，查詢、授權與撤銷也統一回傳 404', async () => {
    await expect(service.list(admin, 'folder', 'deleted-folder')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.grant(
        admin,
        'folder',
        'deleted-folder',
        'user',
        'user-1',
        'view',
        null,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.revoke(admin, 'folder', 'deleted-folder', 'permission-1', null),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(can).not.toHaveBeenCalled();
    expect(permissionUpsert).not.toHaveBeenCalled();
    expect(permissionDeleteMany).not.toHaveBeenCalled();
  });

  it('全域權限列表不顯示指向已刪除資源的孤兒授權', async () => {
    findManagedResources.mockResolvedValue('all');
    permissionFindMany.mockResolvedValue([
      {
        id: 'permission-1',
        resourceType: 'document',
        resourceId: 'deleted-document',
        principalType: 'user',
        principalId: 'user-1',
        permissionLevel: 'view',
        grantedBy: 'admin-1',
      },
    ]);
    folderFindMany.mockResolvedValue([]);
    documentFindMany.mockResolvedValue([]);

    await expect(service.listGlobal(admin, true)).resolves.toEqual([]);
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});
