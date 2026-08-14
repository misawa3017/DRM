import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { AclService } from '../acl/acl.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
@ApiTags('稽核')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly aclService: AclService,
    private readonly usersService: UsersService,
  ) {}

  @Get('folders/:id/audit-logs')
  @ApiOperation({ summary: '列出資料夾稽核紀錄', description: '需要該資料夾的 manage 權限。' })
  @ApiParam({ name: 'id', description: '資料夾 ID', format: 'uuid' })
  @ApiForbiddenResponse({ description: '沒有資料夾管理權限' })
  async folderAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can(
      { id: user.id, roles: req.user.roles },
      'folder',
      id,
      'manage',
    );
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this folder');
    }
    const logs = await this.auditService.listForResource('folder', id);
    return logs.map((log) => ({ ...log, sequence: log.sequence.toString() }));
  }

  @Get('documents/:id/audit-logs')
  @ApiOperation({ summary: '列出文件稽核紀錄', description: '需要該文件的 manage 權限。' })
  @ApiParam({ name: 'id', description: '文件 ID', format: 'uuid' })
  @ApiForbiddenResponse({ description: '沒有文件管理權限' })
  async documentAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can(
      { id: user.id, roles: req.user.roles },
      'document',
      id,
      'manage',
    );
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this document');
    }
    const logs = await this.auditService.listForResource('document', id);
    return logs.map((log) => ({ ...log, sequence: log.sequence.toString() }));
  }

  @Get('audit-logs/verify')
  @ApiOperation({ summary: '驗證全域稽核雜湊鏈', description: '僅限 admin 角色。' })
  @ApiForbiddenResponse({ description: '僅限管理員' })
  async verify(@Req() req: AuthenticatedRequest) {
    if (!req.user.roles.includes('admin')) {
      throw new ForbiddenException('Only admins can verify the audit chain');
    }
    return this.auditService.verifyChain();
  }
}
