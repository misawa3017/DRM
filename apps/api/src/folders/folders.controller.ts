import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { FoldersService } from './folders.service';
import { UsersService } from '../users/users.service';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { UpdateWatermarkDto } from '../documents/dto/update-watermark.dto';
import { DocumentPolicyService } from '../documents/document-policy.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller('folders')
@UseGuards(AuthGuard('jwt'))
export class FoldersController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly usersService: UsersService,
    private readonly policyService: DocumentPolicyService,
  ) {}

  @Get()
  async listRoot(@Req() req: AuthenticatedRequest) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.listRootFolders({ id: user.id, roles: req.user.roles });
  }

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: CreateFolderDto) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.create(
      { id: user.id, roles: req.user.roles },
      body.name,
      body.parentId ?? null,
      req.ip ?? null,
    );
  }

  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateFolderDto,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.update(
      { id: user.id, roles: req.user.roles },
      id,
      { name: body.name, parentId: body.parentId },
      req.ip ?? null,
    );
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.getWithContents({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }

  @Patch(':id/watermark')
  async updateWatermark(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateWatermarkDto,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.policyService.updateFolderWatermark(
      { id: user.id, roles: req.user.roles },
      id,
      body.watermarkEnabled,
      req.ip ?? null,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.foldersService.delete({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }
}
