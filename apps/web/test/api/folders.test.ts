import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listRootFolders, createFolder } from '../../src/api/folders';

describe('folders api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('listRootFolders calls GET /folders', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listRootFolders('fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders');
  });

  it('createFolder POSTs a JSON body with name and parentId', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: '1' }),
    } as Response);

    await createFolder({ name: 'Docs', parentId: 'parent-1' }, 'fake-token');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Docs', parentId: 'parent-1' });
  });
});
