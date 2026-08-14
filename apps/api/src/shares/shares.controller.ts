import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UsersService } from '../users/users.service';
import { SharesService } from './shares.service';
import { CreateDocumentShareDto } from './dto/create-document-share.dto';
import { UpdateDocumentShareDto } from './dto/update-document-share.dto';
import { createAttachmentContentDisposition } from '../documents/content-disposition';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller()
@UseGuards(AuthGuard('jwt'))
@ApiTags('限時分享')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
export class SharesController {
  constructor(
    private readonly shares: SharesService,
    private readonly users: UsersService,
  ) {}

  @Post('documents/:documentId/shares')
  @ApiOperation({
    summary: '建立限時文件分享',
    description: '有效期僅能以小時計算（1–720）。含 Excel 遮蔽規則時為唯讀分享。',
  })
  @ApiParam({ name: 'documentId', description: '文件 ID', format: 'uuid' })
  async create(
    @Req() req: AuthenticatedRequest,
    @Param('documentId') documentId: string,
    @Body() dto: CreateDocumentShareDto,
  ) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.create(
      { id: user.id, roles: req.user.roles },
      documentId,
      dto,
      req.ip ?? null,
    );
  }

  @Get('documents/:documentId/shares')
  @ApiOperation({ summary: '列出文件建立的分享' })
  @ApiParam({ name: 'documentId', description: '文件 ID', format: 'uuid' })
  async listForDocument(@Req() req: AuthenticatedRequest, @Param('documentId') documentId: string) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.listForDocument({ id: user.id, roles: req.user.roles }, documentId);
  }

  @Get('shares/received')
  @ApiOperation({ summary: '列出目前使用者收到且仍有效的分享' })
  async received(@Req() req: AuthenticatedRequest) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.listReceived({ id: user.id, roles: req.user.roles });
  }

  @Patch('shares/:shareId')
  @ApiOperation({ summary: '更新分享權限或延長有效時間' })
  @ApiParam({ name: 'shareId', description: '分享 ID', format: 'uuid' })
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('shareId') shareId: string,
    @Body() dto: UpdateDocumentShareDto,
  ) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.update({ id: user.id, roles: req.user.roles }, shareId, dto, req.ip ?? null);
  }

  @Delete('shares/:shareId')
  @HttpCode(204)
  @ApiOperation({ summary: '撤銷分享' })
  @ApiParam({ name: 'shareId', description: '分享 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '分享已撤銷' })
  async revoke(@Req() req: AuthenticatedRequest, @Param('shareId') shareId: string) {
    const user = await this.users.upsertFromToken(req.user);
    await this.shares.revoke({ id: user.id, roles: req.user.roles }, shareId, req.ip ?? null);
  }

  @Get('shares/:shareId/download')
  @ApiOperation({ summary: '下載收到的分享文件' })
  @ApiParam({ name: 'shareId', description: '分享 ID', format: 'uuid' })
  @ApiOkResponse({ description: '以原始 MIME type 回傳二進位檔案' })
  async download(
    @Req() req: AuthenticatedRequest,
    @Param('shareId') shareId: string,
    @Res() res: Response,
  ) {
    const user = await this.users.upsertFromToken(req.user);
    const content = await this.shares.getContent(
      { id: user.id, roles: req.user.roles, email: user.email },
      shareId,
      req.ip ?? null,
    );
    res.setHeader('Content-Type', content.mimeType);
    res.setHeader('Content-Disposition', createAttachmentContentDisposition(content.fileName));
    content.stream.pipe(res);
  }

  @Get('shares/:shareId/editor-config')
  @Header('Cache-Control', 'no-store, private')
  @ApiOperation({
    summary: '取得 OnlyOffice 編輯器設定',
    description: '僅適用於有效且具 edit 權限的 Office 分享。',
  })
  @ApiParam({ name: 'shareId', description: '分享 ID', format: 'uuid' })
  async editorConfig(@Req() req: AuthenticatedRequest, @Param('shareId') shareId: string) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.getEditorConfig(
      { id: user.id, roles: req.user.roles, email: user.email },
      shareId,
      req.ip ?? null,
    );
  }
}
