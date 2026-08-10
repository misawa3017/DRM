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
import { DocumentsService } from './documents.service';
import { UsersService } from '../users/users.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UpdateExpirationDto } from './dto/update-expiration.dto';
import { UpdateWatermarkDto } from './dto/update-watermark.dto';
import { DocumentPolicyService } from './document-policy.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

@Controller('documents')
@UseGuards(AuthGuard('jwt'))
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly usersService: UsersService,
    private readonly policyService: DocumentPolicyService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
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
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.documentsService.delete({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }

  @Patch(':id/expiration')
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
  async listVersions(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.listVersions({ id: user.id, roles: req.user.roles }, id);
  }

  @Get(':id')
  async getMetadata(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.getMetadata({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }

  @Get(':id/download')
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
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
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
  async preview(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
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
