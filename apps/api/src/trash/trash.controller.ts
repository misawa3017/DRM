import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UsersService } from '../users/users.service';
import { TrashService } from './trash.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller('trash')
@UseGuards(AuthGuard('jwt'))
@ApiTags('回收桶')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
@ApiForbiddenResponse({ description: '僅限 admin 角色管理回收桶' })
export class TrashController {
  constructor(
    private readonly trash: TrashService,
    private readonly users: UsersService,
  ) {}

  private async admin(req: AuthenticatedRequest) {
    if (!req.user.roles.includes('admin'))
      throw new ForbiddenException('Only admins can manage the trash');
    const user = await this.users.upsertFromToken(req.user);
    return { id: user.id, roles: req.user.roles };
  }

  @Get()
  @ApiOperation({ summary: '列出回收桶內容', description: '僅限 admin 角色。' })
  async list(@Req() req: AuthenticatedRequest) {
    await this.admin(req);
    return this.trash.list();
  }

  @Post('folders/:id/restore')
  @HttpCode(204)
  @ApiOperation({ summary: '還原資料夾', description: '僅限 admin 角色。' })
  @ApiParam({ name: 'id', description: '已刪除資料夾 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '資料夾已還原' })
  async restoreFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.trash.restoreFolder(await this.admin(req), id, req.ip ?? null);
  }

  @Post('documents/:id/restore')
  @HttpCode(204)
  @ApiOperation({ summary: '還原文件', description: '僅限 admin 角色。' })
  @ApiParam({ name: 'id', description: '已刪除文件 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '文件已還原' })
  async restoreDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.trash.restoreDocument(await this.admin(req), id, req.ip ?? null);
  }

  @Delete('folders/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: '永久刪除資料夾',
    description: '會一併永久刪除其內容；僅限 admin 角色。',
  })
  @ApiParam({ name: 'id', description: '已刪除資料夾 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '資料夾已永久刪除' })
  async purgeFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.trash.purgeFolder(await this.admin(req), id, req.ip ?? null);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @ApiOperation({ summary: '永久刪除文件', description: '僅限 admin 角色。' })
  @ApiParam({ name: 'id', description: '已刪除文件 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '文件已永久刪除' })
  async purgeDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.trash.purgeDocument(await this.admin(req), id, req.ip ?? null);
  }
}
