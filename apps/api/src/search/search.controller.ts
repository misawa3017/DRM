import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SearchService } from './search.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
@ApiTags('搜尋')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly usersService: UsersService,
  ) {}

  @Get('search')
  @ApiOperation({ summary: '搜尋可存取的資料夾與文件' })
  @ApiQuery({ name: 'q', required: false, example: '預算', description: '搜尋關鍵字' })
  async search(@Req() req: AuthenticatedRequest, @Query('q') q?: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.searchService.search(
      { id: user.id, roles: req.user.roles },
      typeof q === 'string' ? q : '',
    );
  }
}
