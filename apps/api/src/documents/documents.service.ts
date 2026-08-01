import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { StorageService } from '../storage/storage.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly storage: StorageService,
  ) {}

  async createDocument(
    user: AuthenticatedUser,
    folderId: string,
    name: string,
    file: UploadedFile,
  ) {
    const allowed = await this.acl.can(user, 'folder', folderId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this folder');
    }

    const documentId = randomUUID();
    const versionId = randomUUID();
    const objectKey = `${documentId}/${versionId}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.putObject(objectKey, file.buffer, file.mimetype);

    return this.prisma.$transaction(async (tx) => {
      await tx.document.create({
        data: {
          id: documentId,
          folderId,
          name,
          createdBy: user.id,
        },
      });
      const version = await tx.documentVersion.create({
        data: {
          id: versionId,
          documentId,
          versionNumber: 1,
          objectKey,
          sha256,
          mimeType: file.mimetype,
          sizeBytes: file.buffer.length,
          uploadedBy: user.id,
        },
      });
      return tx.document.update({
        where: { id: documentId },
        data: { currentVersionId: version.id },
        include: { currentVersion: true },
      });
    });
  }

  async addVersion(user: AuthenticatedUser, documentId: string, file: UploadedFile) {
    const allowed = await this.acl.can(user, 'document', documentId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this document');
    }

    const latest = await this.prisma.documentVersion.findFirst({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
    });
    const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

    const versionId = randomUUID();
    const objectKey = `${documentId}/${versionId}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.putObject(objectKey, file.buffer, file.mimetype);

    return this.prisma.$transaction(async (tx) => {
      const version = await tx.documentVersion.create({
        data: {
          id: versionId,
          documentId,
          versionNumber: nextVersionNumber,
          objectKey,
          sha256,
          mimeType: file.mimetype,
          sizeBytes: file.buffer.length,
          uploadedBy: user.id,
        },
      });

      await tx.document.update({
        where: { id: documentId },
        data: { currentVersionId: version.id },
      });

      return version;
    });
  }

  async listVersions(user: AuthenticatedUser, documentId: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    return this.prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
    });
  }
}
