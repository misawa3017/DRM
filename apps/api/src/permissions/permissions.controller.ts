import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
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
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PermissionsService } from './permissions.service';
import { UsersService } from '../users/users.service';
import { GrantPermissionDto } from './dto/grant-permission.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
@ApiTags('權限')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
export class PermissionsController {
  constructor(
    private readonly permissionsService: PermissionsService,
    private readonly usersService: UsersService,
  ) {}

  @Get('permissions')
  @ApiOperation({ summary: '列出目前使用者可管理的權限' })
  @ApiQuery({
    name: 'includeInherited',
    required: false,
    type: Boolean,
    description: '是否包含繼承自父資料夾的權限',
  })
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
  @ApiOperation({ summary: '授予資料夾權限' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
  async grantOnFolder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: GrantPermissionDto,
  ) {
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
  @ApiOperation({ summary: '列出資料夾權限' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
  async listOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'folder', id);
  }

  @Delete('folders/:id/permissions/:permissionId')
  @HttpCode(204)
  @ApiOperation({ summary: '撤銷資料夾權限' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
  @ApiParam({ name: 'permissionId', description: '權限記錄 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '權限已撤銷' })
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
  @ApiOperation({ summary: '授予文件權限' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  async grantOnDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: GrantPermissionDto,
  ) {
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
  @ApiOperation({ summary: '列出文件權限' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  async listOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'document', id);
  }

  @Delete('documents/:id/permissions/:permissionId')
  @HttpCode(204)
  @ApiOperation({ summary: '撤銷文件權限' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  @ApiParam({ name: 'permissionId', description: '權限記錄 ID', format: 'uuid' })
  @ApiNoContentResponse({ description: '權限已撤銷' })
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
