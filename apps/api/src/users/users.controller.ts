import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { UsersService } from './users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(AuthGuard('jwt'))
  @Get('whoami')
  async whoami(@Req() req: AuthenticatedRequest) {
    const { sub, email, name, roles } = req.user;
    const user = await this.usersService.upsertFromToken({ sub, email, name });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles,
    };
  }
}
