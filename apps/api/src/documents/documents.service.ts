import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobData } from '@drm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import {
  ScanResult,
  VirusScanIndeterminateError,
  VirusScanSizeLimitError,
  VirusScanService,
} from './virus-scan.service';

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
      await this.conversionQueue.add(
        'convert',
        {
          documentVersionId: versionId,
          objectKey,
          mimeType,
        },
        {
          // A single transient Gotenberg blip shouldn't permanently cost
          // the document its preview -- retry a few times with backoff
          // before giving up (the 'failed' event handler in
          // ConversionEventsListener still logs the final failure).
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          // Without these, BullMQ keeps every completed/failed job record
          // in Redis forever -- unbounded growth for the life of the
          // system. Cap it instead; these numbers are generous enough for
          // debugging recent history without being unbounded.
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to enqueue conversion job for document version ${versionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Same rationale as FoldersService.assertNoFolderNameConflict: application-
  // level check, deletedAt: null excludes soft-deleted siblings from the
  // conflict check.
  private async assertNoDocumentNameConflict(
    folderId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const conflict = await this.prisma.document.findFirst({
      where: {
        folderId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ConflictException('A document with this name already exists in this folder');
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
  //
  // Two additional, distinct failure modes are translated into their own
  // typed HTTP errors here rather than being left to fall through as a raw
  // 500 (see VirusScanService.scanBuffer's doc comment for why each can
  // happen):
  //   - VirusScanIndeterminateError (clamd returned no clear verdict, e.g.
  //     a scan timeout): fails closed, not silently "clean" -- 503, since
  //     this is an infrastructure problem, not something wrong with the
  //     file itself, and must read as clearly different from a confirmed
  //     infection.
  //   - VirusScanSizeLimitError (buffer exceeds clamd.conf's
  //     StreamMaxLength): 413, since this is a real constraint on what the
  //     client uploaded, not a security rejection or a scan failure.
  private async rejectIfInfected(
    file: UploadedFile,
    actorId: string,
    resourceType: 'folder' | 'document',
    resourceId: string,
    ipAddress: string | null,
  ): Promise<void> {
    let scanResult: ScanResult;
    try {
      scanResult = await this.virusScan.scanBuffer(file.buffer);
    } catch (error) {
      if (error instanceof VirusScanSizeLimitError) {
        throw new PayloadTooLargeException(
          'Upload rejected: file exceeds the virus scanner\'s maximum scannable size',
        );
      }
      if (error instanceof VirusScanIndeterminateError) {
        throw new ServiceUnavailableException(
          'Upload rejected: virus scan could not be completed',
        );
      }
      throw error;
    }
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
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.deletedAt) {
      throw new NotFoundException('Folder not found');
    }
    await this.assertNoDocumentNameConflict(folderId, name);

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

  async update(
    user: AuthenticatedUser,
    documentId: string,
    changes: { name?: string; folderId?: string },
    ipAddress: string | null,
  ) {
    const allowed = await this.acl.can(user, 'document', documentId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this document');
    }

    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }

    let newFolderId = document.folderId;
    if (changes.folderId !== undefined) {
      if (changes.folderId === null) {
        throw new BadRequestException('folderId cannot be null');
      }
      const destinationAllowed = await this.acl.can(user, 'folder', changes.folderId, 'edit');
      if (!destinationAllowed) {
        throw new ForbiddenException('You do not have edit access to the destination folder');
      }
      const destination = await this.prisma.folder.findUnique({ where: { id: changes.folderId } });
      if (!destination || destination.deletedAt) {
        throw new NotFoundException('Destination folder not found');
      }
      newFolderId = changes.folderId;
    }

    const newName = changes.name ?? document.name;
    if (changes.name !== undefined || changes.folderId !== undefined) {
      await this.assertNoDocumentNameConflict(newFolderId, newName, document.id);
    }

    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: { name: newName, folderId: newFolderId },
    });

    if (changes.name !== undefined && changes.name !== document.name) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'document_rename',
        resourceType: 'document',
        resourceId: documentId,
        ipAddress,
        details: { oldName: document.name, newName: changes.name },
      });
    }
    if (changes.folderId !== undefined && changes.folderId !== document.folderId) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'document_move',
        resourceType: 'document',
        resourceId: documentId,
        ipAddress,
        details: { oldFolderId: document.folderId, newFolderId: changes.folderId },
      });
    }

    return updated;
  }

  async delete(user: AuthenticatedUser, documentId: string, ipAddress: string | null): Promise<void> {
    const allowed = await this.acl.can(user, 'document', documentId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this document');
    }

    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }

    await this.prisma.document.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_delete',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
    });
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
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
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
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { currentVersion: true },
    });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_view',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
    });

    // The UI uses this to decide whether to offer a "manage permissions"
    // link at all — GET /documents/:id/permissions requires 'manage', a
    // higher bar than the 'view' access that gets a caller into this
    // method, so a caller can legitimately see the document yet not be
    // allowed to see or edit its ACL.
    const canManage = await this.acl.can(user, 'document', documentId, 'manage');

    return { ...document, canManage };
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
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
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
