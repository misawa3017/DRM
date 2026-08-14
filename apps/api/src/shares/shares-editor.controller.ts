import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SharesService } from './shares.service';
import { createAttachmentContentDisposition } from '../documents/content-disposition';

// 這個端點只供 OnlyOffice Document Server 取檔；短效 HMAC 權杖同時繫結分享與收件人，
// 不使用 MinIO 直連或長期憑證。回呼另要求 OnlyOffice JWT，避免短效 URL 外洩後遭偽造。
@Controller('shares')
export class SharesEditorController {
  constructor(private readonly shares: SharesService) {}

  @Get(':shareId/content')
  async content(
    @Param('shareId') shareId: string,
    @Query('editorToken') editorToken: string,
    @Res() res: Response,
  ) {
    const content = await this.shares.getEditorContent(shareId, editorToken);
    res.setHeader('Content-Type', content.mimeType);
    res.setHeader('Content-Disposition', createAttachmentContentDisposition(content.fileName));
    content.stream.pipe(res);
  }

  @Post(':shareId/onlyoffice/callback')
  @HttpCode(HttpStatus.OK)
  async callback(
    @Param('shareId') shareId: string,
    @Query('editorToken') editorToken: string,
    @Body() body: { status?: number; url?: string; token?: string },
  ) {
    return this.shares.saveOnlyOfficeResult(shareId, editorToken, body);
  }
}
