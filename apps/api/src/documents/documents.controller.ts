import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { UsersService } from '../users/users.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UpdateExpirationDto } from './dto/update-expiration.dto';
import { UpdateWatermarkDto } from './dto/update-watermark.dto';
import { DocumentPolicyService } from './document-policy.service';
import { createAttachmentContentDisposition } from './content-disposition';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

@Controller('documents')
@UseGuards(AuthGuard('jwt'))
@ApiTags('文件')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly usersService: UsersService,
    private readonly policyService: DocumentPolicyService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiOperation({
    summary: '上傳文件',
    description: '檔案最大 200 MiB；以 multipart/form-data 傳送。',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'folderId', 'name'],
      properties: {
        file: { type: 'string', format: 'binary' },
        folderId: { type: 'string', format: 'uuid' },
        name: { type: 'string', example: '年度預算.xlsx' },
      },
    },
  })
  async create(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CreateDocumentDto,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.createDocument(
      { id: user.id, roles: req.user.roles },
      body.folderId,
      body.name,
      { buffer: file.buffer, mimetype: file.mimetype },
      req.ip ?? null,
    );
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiOperation({
    summary: '新增文件版本',
    description: '檔案最大 200 MiB；以 multipart/form-data 傳送。',
  })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async addVersion(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.addVersion(
      { id: user.id, roles: req.user.roles },
      id,
      { buffer: file.buffer, mimetype: file.mimetype },
      req.ip ?? null,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新文件名稱或所在資料夾' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateDocumentDto,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.update(
      { id: user.id, roles: req.user.roles },
      id,
      { name: body.name, folderId: body.folderId },
      req.ip ?? null,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: '將文件移至回收桶' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '已移至回收桶' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.documentsService.delete({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }

  @Patch(':id/expiration')
  @ApiOperation({ summary: '設定或取消文件到期時間' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  async updateExpiration(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateExpirationDto,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.policyService.updateExpiration(
      { id: user.id, roles: req.user.roles },
      id,
      body.expiresAt,
      req.ip ?? null,
    );
  }

  @Patch(':id/watermark')
  @ApiOperation({ summary: '設定文件浮水印' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  async updateWatermark(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateWatermarkDto,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.policyService.updateDocumentWatermark(
      { id: user.id, roles: req.user.roles },
      id,
      body.watermarkEnabled,
      req.ip ?? null,
      body.watermarkTemplate,
    );
  }

  @Get(':id/versions')
  @ApiOperation({ summary: '列出文件版本' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  async listVersions(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.listVersions({ id: user.id, roles: req.user.roles }, id);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得文件中繼資料' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  async getMetadata(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.getMetadata(
      { id: user.id, roles: req.user.roles },
      id,
      req.ip ?? null,
    );
  }

  @Get(':id/download')
  @ApiOperation({ summary: '下載文件或指定版本' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  @ApiQuery({
    name: 'versionId',
    required: false,
    description: '要下載的版本 ID；未提供時為目前版本',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ description: '以原始 MIME type 回傳二進位檔案' })
  async download(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('versionId') versionId: string | undefined,
    @Res() res: Response,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    const { stream, mimeType, fileName } = await this.documentsService.getDownloadStream(
      { id: user.id, roles: req.user.roles, email: user.email },
      id,
      versionId,
      req.ip ?? null,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', createAttachmentContentDisposition(fileName));
    stream.on('error', (err) => {
      console.error('Error streaming document download from storage:', err);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read file from storage' });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: '取得文件預覽檔' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  @ApiOkResponse({ description: '以 inline Content-Disposition 回傳預覽檔' })
  async preview(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Res() res: Response) {
    const user = await this.usersService.upsertFromToken(req.user);
    const { stream, mimeType } = await this.documentsService.getDownloadStream(
      { id: user.id, roles: req.user.roles, email: user.email },
      id,
      undefined,
      req.ip ?? null,
      true,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');
    stream.on('error', (err) => {
      console.error('Error streaming document preview from storage:', err);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to read preview from storage' });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
