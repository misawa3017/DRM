import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { UsersService } from '../users/users.service';
import { SharesService } from './shares.service';
import { CreateDocumentShareDto } from './dto/create-document-share.dto';
import { UpdateDocumentShareDto } from './dto/update-document-share.dto';
import { createAttachmentContentDisposition } from '../documents/content-disposition';

interface AuthenticatedRequest extends Request { user: { sub: string; email: string; name: string; roles: string[] } }

@Controller()
@UseGuards(AuthGuard('jwt'))
export class SharesController {
  constructor(private readonly shares: SharesService, private readonly users: UsersService) {}

  @Post('documents/:documentId/shares')
  async create(@Req() req: AuthenticatedRequest, @Param('documentId') documentId: string, @Body() dto: CreateDocumentShareDto) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.create({ id: user.id, roles: req.user.roles }, documentId, dto, req.ip ?? null);
  }

  @Get('documents/:documentId/shares')
  async listForDocument(@Req() req: AuthenticatedRequest, @Param('documentId') documentId: string) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.listForDocument({ id: user.id, roles: req.user.roles }, documentId);
  }

  @Get('shares/received')
  async received(@Req() req: AuthenticatedRequest) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.listReceived({ id: user.id, roles: req.user.roles });
  }

  @Patch('shares/:shareId')
  async update(@Req() req: AuthenticatedRequest, @Param('shareId') shareId: string, @Body() dto: UpdateDocumentShareDto) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.update({ id: user.id, roles: req.user.roles }, shareId, dto, req.ip ?? null);
  }

  @Delete('shares/:shareId')
  @HttpCode(204)
  async revoke(@Req() req: AuthenticatedRequest, @Param('shareId') shareId: string) {
    const user = await this.users.upsertFromToken(req.user);
    await this.shares.revoke({ id: user.id, roles: req.user.roles }, shareId, req.ip ?? null);
  }

  @Get('shares/:shareId/download')
  async download(@Req() req: AuthenticatedRequest, @Param('shareId') shareId: string, @Res() res: Response) {
    const user = await this.users.upsertFromToken(req.user);
    const content = await this.shares.getContent({ id: user.id, roles: req.user.roles, email: user.email }, shareId, req.ip ?? null);
    res.setHeader('Content-Type', content.mimeType);
    res.setHeader('Content-Disposition', createAttachmentContentDisposition(content.fileName));
    content.stream.pipe(res);
  }

  @Get('shares/:shareId/editor-config')
  @Header('Cache-Control', 'no-store, private')
  async editorConfig(@Req() req: AuthenticatedRequest, @Param('shareId') shareId: string) {
    const user = await this.users.upsertFromToken(req.user);
    return this.shares.getEditorConfig({ id: user.id, roles: req.user.roles, email: user.email }, shareId, req.ip ?? null);
  }
}
