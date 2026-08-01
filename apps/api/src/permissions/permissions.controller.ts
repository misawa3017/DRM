import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { PermissionLevel, PrincipalType } from '@prisma/client';
import { PermissionsService } from './permissions.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

interface GrantBody {
  principalType: PrincipalType;
  principalId: string;
  permissionLevel: PermissionLevel;
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class PermissionsController {
  constructor(
    private readonly permissionsService: PermissionsService,
    private readonly usersService: UsersService,
  ) {}

  @Post('folders/:id/permissions')
  async grantOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantBody) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'folder',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
    );
  }

  @Get('folders/:id/permissions')
  async listOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'folder', id);
  }

  @Delete('folders/:id/permissions/:permissionId')
  @HttpCode(204)
  async revokeOnFolder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.permissionsService.revoke({ id: user.id, roles: req.user.roles }, 'folder', id, permissionId);
  }

  @Post('documents/:id/permissions')
  async grantOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantBody) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'document',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
    );
  }

  @Get('documents/:id/permissions')
  async listOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'document', id);
  }

  @Delete('documents/:id/permissions/:permissionId')
  @HttpCode(204)
  async revokeOnDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.permissionsService.revoke({ id: user.id, roles: req.user.roles }, 'document', id, permissionId);
  }
}
