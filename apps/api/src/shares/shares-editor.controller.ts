import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SharesService } from './shares.service';
import { createAttachmentContentDisposition } from '../documents/content-disposition';

// 這個端點只供 OnlyOffice Document Server 取檔；短效 HMAC 權杖同時繫結分享與收件人，
// 不使用 MinIO 直連或長期憑證。OnlyOffice 回呼儲存會在下一階段接入版本工作流程。
@Controller('shares')
export class SharesEditorController {
  constructor(private readonly shares: SharesService) {}

  @Get(':shareId/content')
  async content(@Param('shareId') shareId: string, @Query('editorToken') editorToken: string, @Res() res: Response) {
    const content = await this.shares.getEditorContent(shareId, editorToken);
    res.setHeader('Content-Type', content.mimeType);
    res.setHeader('Content-Disposition', createAttachmentContentDisposition(content.fileName));
    content.stream.pipe(res);
  }

  @Post(':shareId/onlyoffice/callback')
  async callback(@Param('shareId') shareId: string, @Query('editorToken') editorToken: string, @Body() body: { status?: number; url?: string }) {
    return this.shares.saveOnlyOfficeResult(shareId, editorToken, body);
  }
}
