import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listPermissions,
  listGlobalPermissions,
  grantPermission,
  revokePermission,
} from '../../src/api/permissions';

describe('permissions api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('listPermissions calls GET /folders/:id/permissions for resourceType folder', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listPermissions('folder', 'folder-1', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/folder-1/permissions');
  });

  it('listPermissions calls GET /documents/:id/permissions for resourceType document', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listPermissions('document', 'doc-1', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/doc-1/permissions');
  });

  it('listGlobalPermissions calls GET /permissions with includeInherited=true', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listGlobalPermissions(true, 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/permissions?includeInherited=true');
  });

  it('listGlobalPermissions calls GET /permissions with includeInherited=false', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listGlobalPermissions(false, 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/permissions?includeInherited=false');
  });

  it('grantPermission POSTs principalType user, principalId, and permissionLevel', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'p1' }),
    } as Response);

    await grantPermission(
      'folder',
      'folder-1',
      { principalId: 'user-1', permissionLevel: 'edit' },
      'fake-token',
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/folder-1/permissions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      principalType: 'user',
      principalId: 'user-1',
      permissionLevel: 'edit',
    });
  });

  it('revokePermission DELETEs the specific permission id', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers(),
    } as Response);

    await revokePermission('document', 'doc-1', 'perm-1', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/doc-1/permissions/perm-1');
    expect(init?.method).toBe('DELETE');
  });
});
