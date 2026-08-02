import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobData } from '@drm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { VirusScanService } from './virus-scan.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
}

// Office mimetypes that get a preview conversion job enqueued after upload.
// Must stay exactly in sync with apps/worker/src/conversion/
// conversion.processor.ts's MIME_EXTENSIONS lookup table for these six
// entries -- the worker's real (LibreOffice/Gotenberg) coverage was
// verified specifically against this set in Task 4, not against a broader
// one, so enqueueing for a mimetype outside this list would hand the
// worker something it isn't proven to convert correctly.
const OFFICE_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly virusScan: VirusScanService,
    @InjectQueue(QUEUE_DOCUMENT_CONVERSION)
    private readonly conversionQueue: Queue<ConversionJobData>,
  ) {}

  // Best-effort: enqueues a preview-conversion job for Office-mimetype
  // uploads. Called after the upload's transaction has committed and its
  // audit entry has been recorded, specifically so that a queue/Redis
  // hiccup here can never turn an already-successful upload into a failed
  // request -- the preview is a secondary enhancement, not part of the
  // upload's contract. Any error here is logged, not thrown.
  private async maybeEnqueueConversion(versionId: string, objectKey: string, mimeType: string) {
    if (!OFFICE_MIME_TYPES.has(mimeType)) {
      return;
    }
    try {
      await this.conversionQueue.add('convert', {
        documentVersionId: versionId,
        objectKey,
        mimeType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue conversion job for document version ${versionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Scans `file` for malware and, if infected, records the rejection as a
  // `virus_detected` audit entry and throws before the caller does any
  // storage.putObject or Prisma write. Uses recordSafely (not record) even
  // though this is a failure path: the client must always get back the 400
  // "infected file" rejection regardless of whether the audit write itself
  // succeeds, the same way recordSafely already protects success-path
  // audits from turning into a misleading 500 for the caller. An audit
  // write failure here is a logged gap, not grounds to mask a real virus
  // detection behind an unrelated 500.
  private async rejectIfInfected(
    file: UploadedFile,
    actorId: string,
    resourceType: 'folder' | 'document',
    resourceId: string,
    ipAddress: string | null,
  ): Promise<void> {
    const scanResult = await this.virusScan.scanBuffer(file.buffer);
    if (scanResult.isInfected) {
      await this.audit.recordSafely({
        actorId,
        action: 'virus_detected',
        resourceType,
        resourceId,
        ipAddress,
      });
      throw new BadRequestException(
        `Upload rejected: infected file detected (${scanResult.viruses.join(', ')})`,
      );
    }
  }

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

    // No Document row exists yet at this point, so the rejection is
    // audited against the upload target (the folder) instead.
    await this.rejectIfInfected(file, user.id, 'folder', folderId, ipAddress);

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

    // versionId/objectKey are the same values just written to the
    // DocumentVersion row created inside the transaction above.
    await this.maybeEnqueueConversion(versionId, objectKey, file.mimetype);

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

    // The Document row already exists here, so audit the rejection against it.
    await this.rejectIfInfected(file, user.id, 'document', documentId, ipAddress);

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

    await this.maybeEnqueueConversion(version.id, version.objectKey, file.mimetype);

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
