import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Readable } from 'node:stream';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import type { CreateDocumentShareDto, MaskRuleDto } from './dto/create-document-share.dto';
import type { UpdateDocumentShareDto } from './dto/update-document-share.dto';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}
interface DownloadingUser extends AuthenticatedUser {
  email: string;
}
interface DocumentShare {
  id: string;
  documentId: string;
  recipientId: string;
  createdBy: string;
  accessLevel: 'view' | 'edit';
  expiresAt: Date;
  revokedAt: Date | null;
  maskRules: unknown;
  maskedObjectKey: string | null;
  sourceVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface SharedRecipient {
  id: string;
  displayName: string;
  email: string;
}
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// OnlyOffice 會依 document.key 快取 callback URL。變更回呼權杖格式時必須提升版本，
// 避免重新開啟文件仍沿用舊工作階段中已到期的回呼權杖。
const ONLYOFFICE_DOCUMENT_KEY_VERSION = 'v4';

@Injectable()
export class SharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private get shareRepository() {
    return (
      this.prisma as unknown as {
        documentShare: {
          findFirst: (args: unknown) => Promise<DocumentShare | null>;
          findUnique: (args: unknown) => Promise<DocumentShare | null>;
          findMany: (args: unknown) => Promise<DocumentShare[]>;
          create: (args: unknown) => Promise<DocumentShare>;
          update: (args: unknown) => Promise<DocumentShare>;
        };
      }
    ).documentShare;
  }

  private async assertManager(user: AuthenticatedUser, documentId: string, share?: DocumentShare) {
    if (share?.createdBy === user.id) return;
    if (!(await this.acl.can(user, 'document', documentId, 'manage'))) {
      throw new ForbiddenException('Only the sharer or a document manager can manage this share');
    }
  }

  private async assertActiveShare(userId: string, shareId: string): Promise<DocumentShare> {
    const share = await this.shareRepository.findFirst({
      where: { id: shareId, recipientId: userId },
    });
    if (!share || share.revokedAt || share.expiresAt <= new Date()) {
      throw new ForbiddenException('This share has expired or been revoked');
    }
    return share;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  private maskValue(value: unknown, mode: MaskRuleDto['mode']): string {
    const text = String(value ?? '');
    if (mode === 'redact') return '***';
    return text.length <= 2
      ? '*'.repeat(text.length)
      : `${text[0]}${'*'.repeat(text.length - 2)}${text.at(-1)}`;
  }

  private async createMaskedCopy(
    documentId: string,
    rules: MaskRuleDto[],
  ): Promise<{ key: string; sourceVersionId: string }> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { currentVersion: true },
    });
    if (!document?.currentVersion)
      throw new NotFoundException('Document or current version not found');
    if (document.currentVersion.mimeType !== XLSX_MIME) {
      throw new BadRequestException(
        'Column masking is currently supported only for .xlsx documents',
      );
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await this.streamToBuffer(
        await this.storage.getObjectStream(document.currentVersion.objectKey),
      )) as never,
    );
    for (const rule of rules) {
      const worksheet = workbook.getWorksheet(rule.sheetName);
      if (!worksheet) throw new BadRequestException(`Worksheet not found: ${rule.sheetName}`);
      const headerRow = worksheet.getRow(1);
      let column = -1;
      headerRow.eachCell((cell, columnNumber) => {
        if (String(cell.value ?? '') === rule.header) column = columnNumber;
      });
      if (column < 1)
        throw new BadRequestException(`Column header not found: ${rule.sheetName}.${rule.header}`);
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1)
          row.getCell(column).value = this.maskValue(row.getCell(column).value, rule.mode);
      });
    }
    const key = `shares/${documentId}/${randomUUID()}.xlsx`;
    await this.storage.putObject(key, Buffer.from(await workbook.xlsx.writeBuffer()), XLSX_MIME);
    return { key, sourceVersionId: document.currentVersion.id };
  }

  async create(
    user: AuthenticatedUser,
    documentId: string,
    dto: CreateDocumentShareDto,
    ipAddress: string | null,
  ) {
    await this.assertManager(user, documentId);
    const [document, recipient] = await Promise.all([
      this.prisma.document.findFirst({
        where: { id: documentId, deletedAt: null },
        include: { currentVersion: true },
      }),
      this.prisma.user.findUnique({ where: { id: dto.recipientId } }),
    ]);
    if (!document) throw new NotFoundException('Document not found');
    if (document.currentVersion?.mimeType !== XLSX_MIME) {
      throw new BadRequestException(
        'Timed sharing is currently supported only for .xlsx documents',
      );
    }
    if (!recipient) throw new NotFoundException('Recipient not found');
    const rules = dto.maskRules ?? [];
    if (
      rules.length > 0 &&
      (await this.acl.resolveEffectiveLevel(
        { id: recipient.id, roles: [] },
        'document',
        documentId,
      ))
    ) {
      throw new BadRequestException(
        'Recipient already has document access; revoke that access before creating a masked share',
      );
    }
    const masked = rules.length > 0 ? await this.createMaskedCopy(documentId, rules) : null;
    const share = await this.shareRepository.create({
      data: {
        documentId,
        recipientId: recipient.id,
        createdBy: user.id,
        accessLevel: dto.accessLevel,
        expiresAt: new Date(Date.now() + dto.durationHours * 60 * 60 * 1000),
        maskRules: rules,
        maskedObjectKey: masked?.key,
        sourceVersionId: masked?.sourceVersionId,
      },
    });
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_share_create' as never,
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
      details: {
        shareId: share.id,
        recipientId: recipient.id,
        accessLevel: dto.accessLevel,
        durationHours: String(dto.durationHours),
        masked: String(rules.length > 0),
      },
    });
    return share;
  }

  async listForDocument(user: AuthenticatedUser, documentId: string) {
    await this.assertManager(user, documentId);
    const shares = await this.shareRepository.findMany({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
    });
    const recipientIds = [...new Set(shares.map((share) => share.recipientId))];
    const recipients = await this.prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, displayName: true, email: true },
    });
    const recipientById = new Map<string, SharedRecipient>(
      recipients.map((recipient) => [recipient.id, recipient]),
    );
    return shares.map((share) => ({
      ...share,
      recipient: recipientById.get(share.recipientId) ?? null,
    }));
  }

  async listReceived(user: AuthenticatedUser) {
    return this.shareRepository.findMany({
      where: { recipientId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { document: { select: { name: true } } },
      orderBy: { expiresAt: 'asc' },
    });
  }

  async update(
    user: AuthenticatedUser,
    shareId: string,
    dto: UpdateDocumentShareDto,
    ipAddress: string | null,
  ) {
    const share = await this.shareRepository.findUnique({ where: { id: shareId } });
    if (!share) throw new NotFoundException('Share not found');
    await this.assertManager(user, share.documentId, share);
    const updated = await this.shareRepository.update({
      where: { id: shareId },
      data: {
        ...(dto.accessLevel && { accessLevel: dto.accessLevel }),
        ...(dto.durationHours && {
          expiresAt: new Date(Date.now() + dto.durationHours * 60 * 60 * 1000),
        }),
      },
    });
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_share_update' as never,
      resourceType: 'document',
      resourceId: share.documentId,
      ipAddress,
      details: {
        shareId,
        accessLevel: dto.accessLevel ?? '',
        durationHours: String(dto.durationHours ?? ''),
      },
    });
    return updated;
  }

  async revoke(user: AuthenticatedUser, shareId: string, ipAddress: string | null) {
    const share = await this.shareRepository.findUnique({ where: { id: shareId } });
    if (!share) throw new NotFoundException('Share not found');
    await this.assertManager(user, share.documentId, share);
    await this.shareRepository.update({ where: { id: shareId }, data: { revokedAt: new Date() } });
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_share_revoke' as never,
      resourceType: 'document',
      resourceId: share.documentId,
      ipAddress,
      details: { shareId },
    });
  }

  async getContent(user: DownloadingUser, shareId: string, ipAddress: string | null) {
    const share = await this.assertActiveShare(user.id, shareId);
    const document = await this.prisma.document.findUnique({
      where: { id: share.documentId },
      include: { currentVersion: true },
    });
    if (!document?.currentVersion || document.deletedAt)
      throw new NotFoundException('Document not found');
    const key = share.maskedObjectKey ?? document.currentVersion.objectKey;
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_share_access' as never,
      resourceType: 'document',
      resourceId: document.id,
      ipAddress,
      details: { shareId, access: 'download' },
    });
    return {
      stream: await this.storage.getObjectStream(key),
      mimeType: document.currentVersion.mimeType,
      fileName: document.name,
      share,
    };
  }

  async getEditorConfig(user: DownloadingUser, shareId: string, ipAddress: string | null) {
    const share = await this.assertActiveShare(user.id, shareId);
    const document = await this.prisma.document.findFirst({
      where: { id: share.documentId, deletedAt: null },
      include: { currentVersion: true },
    });
    if (!document) throw new NotFoundException('Document not found');
    if (document.currentVersion?.mimeType !== XLSX_MIME) {
      throw new BadRequestException(
        'OnlyOffice editing is currently supported only for .xlsx documents',
      );
    }
    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_share_access' as never,
      resourceType: 'document',
      resourceId: share.documentId,
      ipAddress,
      details: { shareId, access: 'editor_open' },
    });
    // 文件 URL 與 callback URL 僅由 OnlyOffice 容器使用；在 Compose 內走
    // 隔離的 API 服務名稱，避免文件服務必須信任內網 TLS 開發憑證。
    const baseUrl = process.env.ONLYOFFICE_API_URL ?? process.env.API_PUBLIC_URL;
    const documentServerUrl = process.env.ONLYOFFICE_URL;
    if (!baseUrl || !documentServerUrl)
      throw new BadRequestException('OnlyOffice is not configured');
    const contentToken = this.createEditorToken(
      share.id,
      user.id,
      'content',
      new Date(Date.now() + 5 * 60_000),
    );
    const callbackToken = this.createEditorToken(
      share.id,
      user.id,
      'callback',
      share.expiresAt,
    );
    const config = {
      documentType: 'spreadsheet',
      document: {
        fileType: 'xlsx',
        key: `${ONLYOFFICE_DOCUMENT_KEY_VERSION}-${share.id}-${share.updatedAt.getTime()}`,
        title: document.name,
        url: `${baseUrl}/shares/${share.id}/content?editorToken=${contentToken}`,
      },
      editorConfig: {
        mode: share.accessLevel === 'edit' ? 'edit' : 'view',
        callbackUrl: `${baseUrl}/shares/${share.id}/onlyoffice/callback?editorToken=${callbackToken}`,
        user: { id: user.id, name: user.email },
      },
    };
    return { documentServerUrl, config: { ...config, token: this.signOnlyOfficeConfig(config) } };
  }

  private signOnlyOfficeConfig(payload: object): string {
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (!secret) throw new BadRequestException('OnlyOffice JWT is not configured');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
  }

  private createEditorToken(
    shareId: string,
    recipientId: string,
    purpose: 'content' | 'callback',
    expiresAt: Date,
  ) {
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (!secret) throw new BadRequestException('OnlyOffice JWT is not configured');
    const payload = Buffer.from(
      JSON.stringify({ shareId, recipientId, purpose, exp: Math.floor(expiresAt.getTime() / 1000) }),
    ).toString('base64url');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  async getEditorContent(shareId: string, editorToken: string) {
    const recipientId = this.verifyEditorToken(shareId, editorToken, 'content');
    const share = await this.assertActiveShare(recipientId, shareId);
    const document = await this.prisma.document.findUnique({
      where: { id: share.documentId },
      include: { currentVersion: true },
    });
    if (!document?.currentVersion || document.deletedAt)
      throw new NotFoundException('Document not found');
    return {
      stream: await this.storage.getObjectStream(
        share.maskedObjectKey ?? document.currentVersion.objectKey,
      ),
      mimeType: document.currentVersion.mimeType,
      fileName: document.name,
    };
  }

  async saveOnlyOfficeResult(
    shareId: string,
    editorToken: string,
    body: { status?: number; url?: string; token?: string },
  ) {
    this.verifyOnlyOfficeCallback(shareId, body);
    const recipientId = this.verifyEditorToken(shareId, editorToken, 'callback');
    const share = await this.assertActiveShare(recipientId, shareId);
    if (share.accessLevel !== 'edit') throw new ForbiddenException('This share is read-only');
    // OnlyOffice status 2/6 indicates a completed save. Other statuses are acknowledgements
    // and must not alter the current shared copy.
    if ((body.status !== 2 && body.status !== 6) || !body.url) return { error: 0 };
    const savedFileUrl = this.resolveOnlyOfficeSavedFileUrl(body.url);
    const response = await fetch(savedFileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok)
      throw new BadRequestException('OnlyOffice could not provide the saved document');
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > 100 * 1024 * 1024)
      throw new BadRequestException('Saved document is too large');
    const savedBuffer = Buffer.from(await response.arrayBuffer());
    if (savedBuffer.length > 100 * 1024 * 1024)
      throw new BadRequestException('Saved document is too large');
    const key = `shares/${share.documentId}/${share.id}/${randomUUID()}.xlsx`;
    await this.storage.putObject(key, savedBuffer, XLSX_MIME);
    await this.shareRepository.update({ where: { id: share.id }, data: { maskedObjectKey: key } });
    await this.audit.recordSafely({
      actorId: recipientId,
      action: 'document_share_access' as never,
      resourceType: 'document',
      resourceId: share.documentId,
      ipAddress: null,
      details: { shareId, access: 'onlyoffice_save' },
    });
    return { error: 0 };
  }

  private verifyEditorToken(
    shareId: string,
    editorToken: string,
    purpose: 'content' | 'callback',
  ): string {
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (!secret) throw new ForbiddenException('OnlyOffice JWT is not configured');
    const [payload, signature] = editorToken.split('.');
    if (!payload || !signature) throw new ForbiddenException('Invalid editor token');
    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new ForbiddenException('Invalid editor token');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      shareId?: string;
      recipientId?: string;
      purpose?: string;
      exp?: number;
    };
    if (
      decoded.shareId !== shareId ||
      !decoded.recipientId ||
      decoded.purpose !== purpose ||
      !decoded.exp ||
      decoded.exp <= Math.floor(Date.now() / 1000)
    )
      throw new ForbiddenException('Editor token expired');
    return decoded.recipientId;
  }

  private resolveOnlyOfficeSavedFileUrl(url: string): URL {
    const documentServerUrl = process.env.ONLYOFFICE_URL;
    if (!documentServerUrl) throw new BadRequestException('OnlyOffice is not configured');
    let savedFileUrl: URL;
    try {
      savedFileUrl = new URL(url);
    } catch {
      throw new BadRequestException('OnlyOffice returned an invalid saved-document URL');
    }
    const trustedDocumentServer = new URL(documentServerUrl);
    if (
      savedFileUrl.protocol !== trustedDocumentServer.protocol ||
      savedFileUrl.host !== trustedDocumentServer.host
    ) {
      throw new ForbiddenException('OnlyOffice returned an untrusted saved-document URL');
    }

    const internalDocumentServerUrl = process.env.ONLYOFFICE_INTERNAL_URL ?? documentServerUrl;
    return new URL(
      `${savedFileUrl.pathname}${savedFileUrl.search}`,
      internalDocumentServerUrl,
    );
  }

  private verifyOnlyOfficeCallback(
    shareId: string,
    body: { status?: number; url?: string; token?: string },
  ): void {
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (!secret || !body.token) throw new ForbiddenException('Missing OnlyOffice callback token');
    const [header, payload, signature] = body.token.split('.');
    if (!header || !payload || !signature)
      throw new ForbiddenException('Invalid OnlyOffice callback token');
    let decodedHeader: { alg?: string };
    let decodedPayload: { key?: string; status?: number; url?: string; exp?: number };
    try {
      decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
        alg?: string;
      };
      decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        key?: string;
        status?: number;
        url?: string;
        exp?: number;
      };
    } catch {
      throw new ForbiddenException('Invalid OnlyOffice callback token');
    }
    if (decodedHeader.alg !== 'HS256')
      throw new ForbiddenException('Invalid OnlyOffice callback token');
    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throw new ForbiddenException('Invalid OnlyOffice callback token');
    }
    if (
      !decodedPayload.key?.startsWith(`${ONLYOFFICE_DOCUMENT_KEY_VERSION}-${shareId}-`) ||
      decodedPayload.status !== body.status ||
      decodedPayload.url !== body.url ||
      (decodedPayload.exp !== undefined && decodedPayload.exp <= Math.floor(Date.now() / 1000))
    ) {
      throw new ForbiddenException('OnlyOffice callback token does not match request');
    }
  }
}
