import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
}

interface AuditLogResponse {
  action: string;
  resourceType: string;
  resourceId: string;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

// The standard EICAR antivirus test string, base64-encoded so the literal
// signature never appears in tracked source (matching the precedent set by
// scripts/verify-clamav.sh in Phase 4A).
const EICAR_BASE64 =
  'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=';

describe('Virus scanning on upload (e2e)', () => {
  it('rejects an infected upload before any storage or DB write, and audits it', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `virus-scan-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const infected = Buffer.from(EICAR_BASE64, 'base64');
    const form = new FormData();
    form.append('folderId', folderId);
    form.append('name', 'eicar.txt');
    form.append('file', infected, { filename: 'eicar.txt' });

    await expect(
      axios.post(`${API_BASE_URL}/documents`, form, {
        headers: { ...authHeader, ...form.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 400 } });

    // No Document row (and therefore no DocumentVersion / MinIO object) was
    // ever created: the folder's `documents` list stays empty.
    const folderContentsRes = await axios.get(`${API_BASE_URL}/folders/${folderId}`, {
      headers: authHeader,
    });
    expect(folderContentsRes.data.documents).toHaveLength(0);

    // The rejection is still audited, deliberately, as a named exception to
    // the "only audit successful actions" rule (see documents.service.ts's
    // rejectIfInfected comment) -- the security-relevant event here IS the
    // rejection itself.
    const auditRes = await axios.get<AuditLogResponse[]>(
      `${API_BASE_URL}/folders/${folderId}/audit-logs`,
      { headers: authHeader },
    );
    expect(auditRes.data).toContainEqual(
      expect.objectContaining({
        action: 'virus_detected',
        resourceType: 'folder',
        resourceId: folderId,
      }),
    );
  });

  it('accepts a clean upload as before', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `virus-scan-clean-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'clean.txt');
    form.append('file', Buffer.from('this file is not infected'), { filename: 'clean.txt' });

    const createRes = await axios.post(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    expect(createRes.status).toBe(201);
  });
});
