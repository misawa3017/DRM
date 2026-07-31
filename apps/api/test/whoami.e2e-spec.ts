import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const KEYCLOAK_MASTER_TOKEN_URL =
  'http://auth.drm.localhost/realms/master/protocol/openid-connect/token';
const KEYCLOAK_REALM_ADMIN_URL = 'http://auth.drm.localhost/admin/realms/drm';
const API_BASE_URL = 'http://api.drm.localhost';

// Bounds how long any single admin/token HTTP call may hang. This matters
// most for withAccessTokenLifespan below: it mutates shared, live Keycloak
// realm state for the duration of a test, and relies on its `finally` block
// running promptly to restore it. Without a request timeout, a slow/stuck
// connection (e.g. host under load) could hang well past the test's own
// timeout, leaving the dev realm's token lifespan corrupted for every other
// user of the stack until someone notices and fixes it by hand.
const HTTP_TIMEOUT_MS = 5000;

interface TokenResponse {
  access_token: string;
}

async function getToken(clientId: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'password',
      client_id: clientId,
      username: 'testuser',
      password: 'testpass',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: HTTP_TIMEOUT_MS },
  );
  return response.data.access_token;
}

async function getTestUserToken(): Promise<string> {
  return getToken('drm-web');
}

/** Base64url-encodes a buffer per RFC 4648 §5, as required for JWT segments. */
function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/**
 * Builds a syntactically valid RS256 JWT signed with a freshly generated,
 * throwaway key pair - i.e. a key Keycloak never published to its JWKS
 * endpoint. Used to simulate tokens from an untrusted issuer/signer: the
 * signature will never verify against Keycloak's real keys, regardless of
 * the claims inside.
 */
function buildTokenWithThrowawayKey(payload: Record<string, unknown>): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(
    Buffer.from(JSON.stringify(payload)),
  )}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

async function getAdminToken(): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_MASTER_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin_dev_password',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: HTTP_TIMEOUT_MS },
  );
  return response.data.access_token;
}

/** Partial shape of a Keycloak RealmRepresentation - only the fields this file touches. */
interface KeycloakRealmRepresentation {
  accessTokenLifespan: number;
  [key: string]: unknown;
}

/** Temporarily sets the realm's access token lifespan, restoring it afterwards. */
async function withAccessTokenLifespan<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const adminToken = await getAdminToken();

  const { data: realm } = await axios.get<KeycloakRealmRepresentation>(KEYCLOAK_REALM_ADMIN_URL, {
    headers: { Authorization: `Bearer ${adminToken}` },
    timeout: HTTP_TIMEOUT_MS,
  });
  const originalLifespan = realm.accessTokenLifespan;

  await axios.put(
    KEYCLOAK_REALM_ADMIN_URL,
    { ...realm, accessTokenLifespan: seconds },
    { headers: { Authorization: `Bearer ${adminToken}` }, timeout: HTTP_TIMEOUT_MS },
  );

  try {
    return await fn();
  } finally {
    // Best-effort restore, bounded by HTTP_TIMEOUT_MS so this can never hang
    // indefinitely; if it still somehow fails, the error surfaces (failing
    // the test loudly) rather than silently leaving the realm corrupted.
    await axios.put(
      KEYCLOAK_REALM_ADMIN_URL,
      { ...realm, accessTokenLifespan: originalLifespan },
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: HTTP_TIMEOUT_MS },
    );
  }
}

describe('GET /whoami (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the authenticated user and persists it', async () => {
    const token = await getTestUserToken();

    const res = await axios.get<{ email: string; roles: string[] }>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.email).toBe('testuser@example.com');
    expect(res.data.roles).toContain('employee');

    // email is no longer a unique constraint (keycloakSub is the identity anchor),
    // so this must be findFirst rather than findUnique.
    const dbUser = await prisma.user.findFirst({ where: { email: 'testuser@example.com' } });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.keycloakSub).toBeDefined();
  });

  it('rejects requests without a token', async () => {
    await expect(axios.get(`${API_BASE_URL}/whoami`)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('rejects a token with a tampered signature', async () => {
    const token = await getTestUserToken();
    const [header, payload, signature] = token.split('.');
    // Flip the signature's first character so the token stays syntactically
    // valid (three base64url segments) but no longer verifies against
    // Keycloak's JWKS.
    const tamperedSignature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    const tamperedToken = `${header}.${payload}.${tamperedSignature}`;

    await expect(
      axios.get(`${API_BASE_URL}/whoami`, {
        headers: { Authorization: `Bearer ${tamperedToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('rejects a token issued (and signed) by an untrusted issuer', async () => {
    const token = buildTokenWithThrowawayKey({
      iss: 'http://not-our-keycloak.example.com/realms/other',
      azp: 'drm-web',
      sub: 'someone',
      email: 'someone@example.com',
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(
      axios.get(`${API_BASE_URL}/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('rejects a genuinely-signed token whose azp is not the drm-web client', async () => {
    // admin-cli is a real client in the drm realm with direct-access-grants
    // enabled, so this token has a valid Keycloak signature, correct issuer,
    // and correct algorithm - it only differs from a legitimate drm-web
    // token in `azp`. Before the azp check was added, this token would have
    // been accepted by /whoami just like a real drm-web token.
    const token = await getToken('admin-cli');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
      azp: string;
    };
    expect(payload.azp).toBe('admin-cli');

    await expect(
      axios.get(`${API_BASE_URL}/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('rejects an expired token', async () => {
    await withAccessTokenLifespan(1, async () => {
      const token = await getTestUserToken();

      // Wait for the 1-second access token to actually expire.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await expect(
        axios.get(`${API_BASE_URL}/whoami`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ).rejects.toMatchObject({ response: { status: 401 } });
    });
  }, 20000);
});
