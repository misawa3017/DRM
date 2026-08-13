import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { cleanupTestFolders } from './e2e-cleanup';

describe('cleanupTestFolders', () => {
  it('只清除指定資料夾的資料列與物件，保留稽核鏈', async () => {
    const storage = { send: jest.fn().mockResolvedValue({}) } as unknown as S3Client;
    const transaction = jest.fn().mockResolvedValue([]);
    const prisma = {
      document: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'doc-1', versions: [{ objectKey: 'original', previewObjectKey: 'preview' }] },
          ]),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      permission: { deleteMany: jest.fn() },
      documentVersion: { deleteMany: jest.fn() },
      folder: { deleteMany: jest.fn() },
      $transaction: transaction,
    };

    await cleanupTestFolders(prisma as never, storage, ['folder-1']);

    expect(storage.send).toHaveBeenCalledWith(expect.any(DeleteObjectsCommand));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(prisma.folder.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['folder-1'] } } });
  });

  it('沒有測試資料夾時不呼叫儲存或資料庫', async () => {
    const storage = { send: jest.fn() } as unknown as S3Client;
    const prisma = { document: { findMany: jest.fn() } };
    await cleanupTestFolders(prisma as never, storage, []);
    expect(storage.send).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });
});
