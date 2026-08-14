import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SharesService } from './shares.service';
import { createAttachmentContentDisposition } from '../documents/content-disposition';

// 這個端點只供 OnlyOffice Document Server 取檔；短效 HMAC 權杖同時繫結分享與收件人，
// 不使用 MinIO 直連或長期憑證。回呼另要求 OnlyOffice JWT，避免短效 URL 外洩後遭偽造。
@Controller('shares')
@ApiTags('OnlyOffice 整合')
export class SharesEditorController {
  constructor(private readonly shares: SharesService) {}

  @Get(':shareId/content')
  @ApiOperation({
    summary: 'OnlyOffice 讀取分享文件內容',
    description: 'OnlyOffice Document Server 的內部端點；需要短效 editorToken。',
  })
  @ApiParam({ name: 'shareId', description: '分享 ID', format: 'uuid' })
  @ApiQuery({ name: 'editorToken', description: '短效、繫結分享與收件人的編輯器權杖' })
  @ApiOkResponse({ description: '以原始 MIME type 回傳二進位檔案' })
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
  @ApiOperation({
    summary: 'OnlyOffice 儲存回呼',
    description: 'OnlyOffice Document Server 的內部端點；驗證 OnlyOffice JWT 與短效 editorToken。',
  })
  @ApiParam({ name: 'shareId', description: '分享 ID', format: 'uuid' })
  @ApiQuery({ name: 'editorToken', description: '短效、繫結分享與收件人的編輯器權杖' })
  @ApiConsumes('application/json')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'integer', example: 2 },
        url: { type: 'string', format: 'uri' },
        token: { type: 'string' },
      },
    },
  })
  async callback(
    @Param('shareId') shareId: string,
    @Query('editorToken') editorToken: string,
    @Body() body: { status?: number; url?: string; token?: string },
  ) {
    return this.shares.saveOnlyOfficeResult(shareId, editorToken, body);
  }
}
