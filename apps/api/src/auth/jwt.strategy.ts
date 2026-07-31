import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/certs`,
      }),
      issuer: process.env.KEYCLOAK_ISSUER,
      algorithms: ['RS256'],
    });
  }

  async validate(payload: any) {
    const expectedClientId = process.env.KEYCLOAK_CLIENT_ID;
    if (!expectedClientId || payload.azp !== expectedClientId) {
      // `azp` (authorized party) identifies which OAuth client the token was
      // issued to. Without this check, any token that is otherwise valid for
      // the `drm` realm (signature, issuer, algorithm) would be accepted
      // here regardless of which client requested it - fine while `drm-web`
      // is the only client, but a silent gap the moment a second client
      // (service account, admin console, mobile app, ...) is registered.
      throw new UnauthorizedException('Token was not issued to the expected client');
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? payload.preferred_username,
      roles: payload.realm_access?.roles ?? [],
    };
  }
}
