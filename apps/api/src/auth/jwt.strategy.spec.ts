import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy#validate', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      KEYCLOAK_ISSUER: 'http://auth.drm.localhost/realms/drm',
      KEYCLOAK_JWKS_URI: 'http://keycloak:8080/realms/drm/protocol/openid-connect/certs',
      KEYCLOAK_CLIENT_ID: 'drm-web',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  const basePayload = {
    sub: 'user-123',
    email: 'jane@example.com',
    name: 'Jane Doe',
    realm_access: { roles: ['employee'] },
  };

  it('accepts a token whose azp matches the configured client id', async () => {
    const strategy = new JwtStrategy();

    const result = await strategy.validate({ ...basePayload, azp: 'drm-web' });

    expect(result).toEqual({
      sub: 'user-123',
      email: 'jane@example.com',
      name: 'Jane Doe',
      roles: ['employee'],
    });
  });

  it('rejects a token whose azp does not match the configured client id', async () => {
    const strategy = new JwtStrategy();

    await expect(
      strategy.validate({ ...basePayload, azp: 'some-other-client' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token that has no azp claim at all', async () => {
    const strategy = new JwtStrategy();

    await expect(strategy.validate({ ...basePayload })).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
