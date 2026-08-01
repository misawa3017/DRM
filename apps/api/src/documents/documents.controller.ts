import {
  Body,
  Controller,
  Get,
  Param,
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
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async create(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { folderId: string; name: string },
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.createDocument(
      { id: user.id, roles: req.user.roles },
      body.folderId,
      body.name,
      { buffer: file.buffer, mimetype: file.mimetype },
    );
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async addVersion(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.addVersion({ id: user.id, roles: req.user.roles }, id, {
      buffer: file.buffer,
      mimetype: file.mimetype,
    });
  }

  @Get(':id/versions')
  async listVersions(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.listVersions({ id: user.id, roles: req.user.roles }, id);
  }

  @Get(':id')
  async getMetadata(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.getMetadata({ id: user.id, roles: req.user.roles }, id);
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
      { id: user.id, roles: req.user.roles },
      id,
      versionId,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    stream.pipe(res);
  }
}
