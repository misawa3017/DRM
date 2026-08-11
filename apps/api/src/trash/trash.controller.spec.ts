import { ForbiddenException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { TrashController } from './trash.controller';
import { TrashService } from './trash.service';

describe('TrashController', () => {
  const list = jest.fn();
  const restoreDocument = jest.fn();
  const upsertFromToken = jest.fn();
  const trash = { list, restoreDocument } as unknown as TrashService;
  const users = { upsertFromToken } as unknown as UsersService;
  const controller = new TrashController(trash, users);

  const adminRequest = {
    user: { sub: 'keycloak-admin', email: 'admin@example.com', name: '管理員', roles: ['admin'] },
    ip: '127.0.0.1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    upsertFromToken.mockResolvedValue({ id: 'user-admin' });
    list.mockResolvedValue([]);
    restoreDocument.mockResolvedValue(undefined);
  });

  it('拒絕非管理員讀取垃圾桶', async () => {
    const request = {
      user: { sub: 'keycloak-user', email: 'user@example.com', name: '一般使用者', roles: ['employee'] },
      ip: '127.0.0.1',
    };

    await expect(controller.list(request as never)).rejects.toThrow(ForbiddenException);
    expect(upsertFromToken).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('以已驗證的管理員身分還原文件並記錄來源 IP', async () => {
    await expect(controller.restoreDocument(adminRequest as never, 'document-1')).resolves.toBeUndefined();

    expect(upsertFromToken).toHaveBeenCalledWith(adminRequest.user);
    expect(restoreDocument).toHaveBeenCalledWith(
      { id: 'user-admin', roles: ['admin'] },
      'document-1',
      '127.0.0.1',
    );
  });
});
