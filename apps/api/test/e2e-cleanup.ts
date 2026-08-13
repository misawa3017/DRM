import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@prisma/client';

/**
 * 清除指定測試資料夾及其文件、版本與 MinIO 物件，絕不依名稱做廣泛刪除。
 * 稽核紀錄刻意保留：AuditLog 是雜湊鏈，刪除其中任一列會破壞不可竄改性。
 */
export async function cleanupTestFolders(
  prisma: PrismaClient,
  storage: S3Client,
  folderIds: string[],
) {
  if (folderIds.length === 0) return;
  const documents = await prisma.document.findMany({
    where: { folderId: { in: folderIds } },
    include: { versions: true },
  });
  const documentIds = documents.map((document) => document.id);
  const objectKeys = documents.flatMap((document) =>
    document.versions.flatMap((version) =>
      version.previewObjectKey
        ? [version.objectKey, version.previewObjectKey]
        : [version.objectKey],
    ),
  );
  if (objectKeys.length > 0) {
    await storage.send(
      new DeleteObjectsCommand({
        Bucket: 'documents',
        Delete: { Objects: objectKeys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
  await prisma.$transaction([
    prisma.permission.deleteMany({
      where: {
        OR: [
          { resourceType: 'folder', resourceId: { in: folderIds } },
          { resourceType: 'document', resourceId: { in: documentIds } },
        ],
      },
    }),
    prisma.document.updateMany({
      where: { id: { in: documentIds } },
      data: { currentVersionId: null },
    }),
    prisma.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } }),
    prisma.document.deleteMany({ where: { id: { in: documentIds } } }),
    prisma.folder.deleteMany({ where: { id: { in: folderIds } } }),
  ]);
}
