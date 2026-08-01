import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AuditService } from './audit.service';
import { AclService } from '../acl/acl.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly aclService: AclService,
    private readonly usersService: UsersService,
  ) {}

  @Get('folders/:id/audit-logs')
  async folderAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can({ id: user.id, roles: req.user.roles }, 'folder', id, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this folder');
    }
    const logs = await this.auditService.listForResource('folder', id);
    return logs.map((log) => ({ ...log, sequence: log.sequence.toString() }));
  }

  @Get('documents/:id/audit-logs')
  async documentAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can({ id: user.id, roles: req.user.roles }, 'document', id, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this document');
    }
    const logs = await this.auditService.listForResource('document', id);
    return logs.map((log) => ({ ...log, sequence: log.sequence.toString() }));
  }

  @Get('audit-logs/verify')
  async verify(@Req() req: AuthenticatedRequest) {
    if (!req.user.roles.includes('admin')) {
      throw new ForbiddenException('Only admins can verify the audit chain');
    }
    return this.auditService.verifyChain();
  }
}
