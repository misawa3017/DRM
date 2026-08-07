import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { PermissionsService } from './permissions.service';
import { UsersService } from '../users/users.service';
import { GrantPermissionDto } from './dto/grant-permission.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class PermissionsController {
  constructor(
    private readonly permissionsService: PermissionsService,
    private readonly usersService: UsersService,
  ) {}

  @Get('permissions')
  async listGlobal(
    @Req() req: AuthenticatedRequest,
    @Query('includeInherited') includeInherited?: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.listGlobal(
      { id: user.id, roles: req.user.roles },
      includeInherited === 'true',
    );
  }

  @Post('folders/:id/permissions')
  async grantOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantPermissionDto) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'folder',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
      req.ip ?? null,
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
    await this.permissionsService.revoke(
      { id: user.id, roles: req.user.roles },
      'folder',
      id,
      permissionId,
      req.ip ?? null,
    );
  }

  @Post('documents/:id/permissions')
  async grantOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantPermissionDto) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'document',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
      req.ip ?? null,
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
    await this.permissionsService.revoke(
      { id: user.id, roles: req.user.roles },
      'document',
      id,
      permissionId,
      req.ip ?? null,
    );
  }
}
