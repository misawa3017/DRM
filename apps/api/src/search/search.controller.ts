import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { SearchService } from './search.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly usersService: UsersService,
  ) {}

  @Get('search')
  async search(@Req() req: AuthenticatedRequest, @Query('q') q?: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.searchService.search({ id: user.id, roles: req.user.roles }, q ?? '');
  }
}
