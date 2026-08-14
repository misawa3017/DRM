import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
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
@ApiTags('資料夾')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
export class FoldersController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly usersService: UsersService,
    private readonly policyService: DocumentPolicyService,
  ) {}

  @Get()
  @ApiOperation({ summary: '列出可存取的根資料夾' })
  async listRoot(@Req() req: AuthenticatedRequest) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.listRootFolders({ id: user.id, roles: req.user.roles });
  }

  @Post()
  @ApiOperation({ summary: '建立資料夾' })
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
  @ApiOperation({ summary: '更新資料夾名稱或父層' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
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
  @ApiOperation({ summary: '取得資料夾及其直接內容' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.getWithContents(
      { id: user.id, roles: req.user.roles },
      id,
      req.ip ?? null,
    );
  }

  @Patch(':id/watermark')
  @ApiOperation({ summary: '設定資料夾預設浮水印' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
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
      body.watermarkTemplate,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: '將資料夾移至回收桶' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '已移至回收桶' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.foldersService.delete({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }
}
