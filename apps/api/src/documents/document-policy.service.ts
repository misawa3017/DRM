import { ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

const SYSTEM_ACTOR_ID = 'system:document-expiration';
const MAX_FOLDER_DEPTH = 100;
export const DEFAULT_WATERMARK_TEMPLATE = '{{email}} | {{datetime}} | {{ip}}';
export const WATERMARK_VARIABLE_PATTERN = /\{\{(email|datetime|ip|documentName)\}\}/g;

export function renderWatermarkTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(WATERMARK_VARIABLE_PATTERN, (_match, key: string) => variables[key] ?? '');
}

interface WatermarkPolicy {
  enabled: boolean;
  template: string;
}

@Injectable()
export class DocumentPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly audit: AuditService,
  ) {}

  assertActive(document: { status: 'active' | 'expired' }): void {
    if (document.status === 'expired') {
      throw new GoneException('Document has expired');
    }
  }

  async resolveWatermarkEnabled(documentId: string): Promise<boolean> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { watermarkEnabled: true, folderId: true },
    });
    if (!document) throw new NotFoundException('Document not found');
    if (document.watermarkEnabled !== null) return document.watermarkEnabled;

    let folderId: string | null = document.folderId;
    for (let depth = 0; folderId && depth < MAX_FOLDER_DEPTH; depth++) {
      const folder: { watermarkEnabled: boolean | null; parentId: string | null } | null =
        await this.prisma.folder.findUnique({
          where: { id: folderId },
          select: { watermarkEnabled: true, parentId: true },
        });
      if (!folder) break;
      if (folder.watermarkEnabled !== null) return folder.watermarkEnabled;
      folderId = folder.parentId;
    }
    return true;
  }

  async resolveWatermarkPolicy(documentId: string): Promise<WatermarkPolicy> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { watermarkEnabled: true, watermarkTemplate: true, folderId: true },
    });
    if (!document) throw new NotFoundException('Document not found');

    let enabled = document.watermarkEnabled;
    let template = document.watermarkTemplate;

    let folderId: string | null = document.folderId;
    for (let depth = 0; folderId && depth < MAX_FOLDER_DEPTH; depth++) {
      const folder: {
        watermarkEnabled: boolean | null;
        watermarkTemplate: string | null;
        parentId: string | null;
      } | null =
        await this.prisma.folder.findUnique({
          where: { id: folderId },
          select: { watermarkEnabled: true, watermarkTemplate: true, parentId: true },
        });
      if (!folder) break;
      enabled ??= folder.watermarkEnabled;
      template ??= folder.watermarkTemplate;
      if (enabled !== null && template !== null) break;
      folderId = folder.parentId;
    }
    return {
      enabled: enabled ?? true,
      template: template?.trim() || DEFAULT_WATERMARK_TEMPLATE,
    };
  }

  async updateExpiration(
    user: AuthenticatedUser,
    documentId: string,
    expiresAt: string | null,
    ipAddress: string | null,
  ) {
    if (!(await this.acl.can(user, 'document', documentId, 'manage'))) {
      throw new ForbiddenException('You do not have manage access to this document');
    }
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) throw new NotFoundException('Document not found');

    const parsed = expiresAt === null ? null : new Date(expiresAt);
    const status = parsed === null || parsed.getTime() > Date.now() ? 'active' : document.status;
    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: { expiresAt: parsed, status },
    });
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_expiry_updated',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
      details: { expiresAt: parsed?.toISOString() ?? 'null' },
    });
    return updated;
  }

  async updateDocumentWatermark(
    user: AuthenticatedUser,
    documentId: string,
    watermarkEnabled: boolean | null,
    ipAddress: string | null,
    watermarkTemplate?: string | null,
  ) {
    if (!(await this.acl.can(user, 'document', documentId, 'manage'))) {
      throw new ForbiddenException('You do not have manage access to this document');
    }
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) throw new NotFoundException('Document not found');
    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: {
        watermarkEnabled,
        ...(watermarkTemplate !== undefined && { watermarkTemplate }),
      },
    });
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_watermark_updated',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
      details: {
        watermarkEnabled: String(watermarkEnabled),
        ...(watermarkTemplate !== undefined && { watermarkTemplate: watermarkTemplate ?? 'inherit' }),
      },
    });
    return updated;
  }

  async updateFolderWatermark(
    user: AuthenticatedUser,
    folderId: string,
    watermarkEnabled: boolean | null,
    ipAddress: string | null,
    watermarkTemplate?: string | null,
  ) {
    if (!(await this.acl.can(user, 'folder', folderId, 'manage'))) {
      throw new ForbiddenException('You do not have manage access to this folder');
    }
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.deletedAt) throw new NotFoundException('Folder not found');
    const updated = await this.prisma.folder.update({
      where: { id: folderId },
      data: {
        watermarkEnabled,
        ...(watermarkTemplate !== undefined && { watermarkTemplate }),
      },
    });
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'folder_watermark_updated',
      resourceType: 'folder',
      resourceId: folderId,
      ipAddress,
      details: {
        watermarkEnabled: String(watermarkEnabled),
        ...(watermarkTemplate !== undefined && { watermarkTemplate: watermarkTemplate ?? 'inherit' }),
      },
    });
    return updated;
  }

  @Cron('0 2 * * *')
  async expireDocuments(now: Date = new Date()): Promise<number> {
    const candidates = await this.prisma.document.findMany({
      where: { status: 'active', expiresAt: { lt: now }, deletedAt: null },
      select: { id: true },
    });
    let expired = 0;
    for (const candidate of candidates) {
      const result = await this.prisma.document.updateMany({
        where: { id: candidate.id, status: 'active', expiresAt: { lt: now }, deletedAt: null },
        data: { status: 'expired' },
      });
      if (result.count !== 1) continue;
      expired += 1;
      await this.audit.recordSafely({
        actorId: SYSTEM_ACTOR_ID,
        action: 'document_expired',
        resourceType: 'document',
        resourceId: candidate.id,
        ipAddress: null,
      });
    }
    return expired;
  }
}
