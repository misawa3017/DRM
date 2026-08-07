import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listRootFolders, createFolder, renameFolder, moveFolder, deleteFolder } from '../../src/api/folders';

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

  it('renameFolder PATCHes a JSON body with the new name', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'f1', name: 'new-name' }),
    } as Response);

    await renameFolder('f1', 'new-name', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/f1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'new-name' });
  });

  it('moveFolder PATCHes a JSON body with the new parentId', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'f1', parentId: 'f2' }),
    } as Response);

    await moveFolder('f1', 'f2', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/f1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ parentId: 'f2' });
  });

  it('deleteFolder DELETEs the folder', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, headers: new Headers() } as Response);

    await deleteFolder('f1', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/f1');
    expect(init?.method).toBe('DELETE');
  });
});
