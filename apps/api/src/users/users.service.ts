import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface TokenPayload {
  sub: string;
  email: string;
  name: string;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertFromToken(payload: TokenPayload) {
    return this.prisma.user.upsert({
      where: { keycloakSub: payload.sub },
      update: { email: payload.email, displayName: payload.name },
      create: {
        keycloakSub: payload.sub,
        email: payload.email,
        displayName: payload.name,
      },
    });
  }

  async search(query?: string): Promise<UserSummary[]> {
    if (!query || query.trim() === '') {
      throw new BadRequestException('search query is required');
    }
    return this.prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, email: true, displayName: true, department: true },
      orderBy: { displayName: 'asc' },
      take: 20,
    });
  }
}
