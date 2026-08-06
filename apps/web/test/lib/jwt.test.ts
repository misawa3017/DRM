import { describe, it, expect } from 'vitest';
import { getRolesFromToken } from '../../src/lib/jwt';

function fakeJwt(payload: unknown): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.signature`;
}

describe('getRolesFromToken', () => {
  it('reads realm_access.roles out of a valid JWT payload', () => {
    const token = fakeJwt({ realm_access: { roles: ['admin', 'user'] } });

    expect(getRolesFromToken(token)).toEqual(['admin', 'user']);
  });

  it('returns an empty array when realm_access is missing', () => {
    const token = fakeJwt({ sub: 'u1' });

    expect(getRolesFromToken(token)).toEqual([]);
  });

  it('returns an empty array for a malformed token instead of throwing', () => {
    expect(getRolesFromToken('not-a-jwt')).toEqual([]);
  });

  it('returns an empty array for an empty token', () => {
    expect(getRolesFromToken('')).toEqual([]);
  });
});
