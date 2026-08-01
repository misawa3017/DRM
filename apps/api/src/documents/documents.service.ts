import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';

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
    private readonly audit: AuditService,
  ) {}

  async createDocument(
    user: AuthenticatedUser,
    folderId: string,
    name: string,
    file: UploadedFile,
    ipAddress: string | null,
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

    const created = await this.prisma.$transaction(async (tx) => {
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

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_create',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
    });

    return created;
  }

  async addVersion(
    user: AuthenticatedUser,
    documentId: string,
    file: UploadedFile,
    ipAddress: string | null,
  ) {
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

    const version = await this.prisma.$transaction(async (tx) => {
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

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_version_upload',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
    });

    return version;
  }

  // Not audited: listVersions is a metadata read on the same document already
  // covered by document_view via getMetadata. The frontend calls getMetadata
  // and listVersions together to render a document page, so logging both
  // would double-record a single logical "viewed this document" event. If
  // listVersions is ever called independently of getMetadata by a future
  // caller, revisit this and audit it separately under document_view.
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

  async getMetadata(user: AuthenticatedUser, documentId: string, ipAddress: string | null) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    const document = await this.prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { currentVersion: true },
    });

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_view',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
    });

    return document;
  }

  async getDownloadStream(
    user: AuthenticatedUser,
    documentId: string,
    versionId: string | undefined,
    ipAddress: string | null,
  ) {
    const allowed = await this.acl.can(user, 'document', documentId, 'download');
    if (!allowed) {
      throw new ForbiddenException('You do not have download access to this document');
    }

    const version = versionId
      ? await this.prisma.documentVersion.findFirstOrThrow({
          where: { id: versionId, documentId },
        })
      : await this.prisma.document
          .findUniqueOrThrow({ where: { id: documentId }, include: { currentVersion: true } })
          .then((doc) => {
            if (!doc.currentVersion) {
              throw new Error(`Document ${documentId} has no current version`);
            }
            return doc.currentVersion;
          });

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_download',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
      details: { versionId: version.id },
    });

    const stream = await this.storage.getObjectStream(version.objectKey);
    return { stream, mimeType: version.mimeType, fileName: version.id };
  }
}
