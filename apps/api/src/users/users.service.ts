import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface TokenPayload {
  sub: string;
  email: string;
  name: string;
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
}
