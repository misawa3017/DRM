import { Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { UsersService } from '../users/users.service';
import { TrashService } from './trash.service';

interface AuthenticatedRequest extends Request { user: { sub: string; email: string; name: string; roles: string[] } }

@Controller('trash')
@UseGuards(AuthGuard('jwt'))
export class TrashController {
  constructor(private readonly trash: TrashService, private readonly users: UsersService) {}

  private async admin(req: AuthenticatedRequest) {
    if (!req.user.roles.includes('admin')) throw new ForbiddenException('Only admins can manage the trash');
    const user = await this.users.upsertFromToken(req.user);
    return { id: user.id, roles: req.user.roles };
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest) { await this.admin(req); return this.trash.list(); }

  @Post('folders/:id/restore')
  @HttpCode(204)
  async restoreFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) { await this.trash.restoreFolder(await this.admin(req), id, req.ip ?? null); }

  @Post('documents/:id/restore')
  @HttpCode(204)
  async restoreDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) { await this.trash.restoreDocument(await this.admin(req), id, req.ip ?? null); }

  @Delete('folders/:id')
  @HttpCode(204)
  async purgeFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) { await this.trash.purgeFolder(await this.admin(req), id, req.ip ?? null); }

  @Delete('documents/:id')
  @HttpCode(204)
  async purgeDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) { await this.trash.purgeDocument(await this.admin(req), id, req.ip ?? null); }
}
