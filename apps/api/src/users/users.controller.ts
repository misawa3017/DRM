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
import { UsersService } from './users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller()
@ApiTags('使用者')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '缺少、過期或無效的 Bearer Token' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(AuthGuard('jwt'))
  @Get('whoami')
  @ApiOperation({ summary: '取得目前登入使用者' })
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

  @UseGuards(AuthGuard('jwt'))
  @Get('users')
  @ApiOperation({ summary: '搜尋可作為權限或分享對象的使用者' })
  @ApiQuery({ name: 'search', required: false, example: '王小明' })
  async search(@Query('search') search?: string) {
    return this.usersService.search(search);
  }
}
