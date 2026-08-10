import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  uploadDocument,
  downloadDocument,
  renameDocument,
  moveDocument,
  deleteDocument,
  updateDocumentExpiration,
  updateDocumentWatermark,
  previewDocument,
} from '../../src/api/documents';

describe('documents api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('uploadDocument POSTs multipart form data with folderId, name and file', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'doc-1' }),
    } as Response);

    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });
    await uploadDocument({ folderId: 'folder-1', name: 'report.pdf', file }, 'fake-token');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe('POST');
    const body = init?.body as FormData;
    expect(body.get('folderId')).toBe('folder-1');
    expect(body.get('name')).toBe('report.pdf');
    expect(body.get('file')).toBe(file);
  });

  it('downloadDocument parses the filename from Content-Disposition and returns a blob', async () => {
    const fakeBlob = new Blob(['data']);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-disposition': 'attachment; filename="report.pdf"' }),
      blob: async () => fakeBlob,
    } as Response);

    const result = await downloadDocument('doc-1', undefined, 'fake-token');

    expect(result.fileName).toBe('report.pdf');
    expect(result.blob).toBe(fakeBlob);
  });

  it('previewDocument requests the protected preview endpoint', async () => {
    const fakeBlob = new Blob(['pdf'], { type: 'application/pdf' });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      blob: async () => fakeBlob,
    } as Response);

    await expect(previewDocument('doc-1', 'fake-token')).resolves.toBe(fakeBlob);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/doc-1/preview');
  });

  it('renameDocument PATCHes a JSON body with the new name', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'd1', name: 'new.txt' }),
    } as Response);

    await renameDocument('d1', 'new.txt', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/d1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'new.txt' });
  });

  it('moveDocument PATCHes a JSON body with the new folderId', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'd1', folderId: 'f2' }),
    } as Response);

    await moveDocument('d1', 'f2', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/d1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ folderId: 'f2' });
  });

  it('deleteDocument DELETEs the document', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, headers: new Headers() } as Response);

    await deleteDocument('d1', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/d1');
    expect(init?.method).toBe('DELETE');
  });

  it('updates watermark and expiration policies with PATCH requests', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'd1' }),
    } as Response);

    await updateDocumentWatermark('d1', null, 'fake-token');
    await updateDocumentExpiration('d1', '2026-08-20T02:30:00.000Z', 'fake-token');

    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/documents/d1/watermark');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({
      watermarkEnabled: null,
    });
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain('/documents/d1/expiration');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string)).toEqual({
      expiresAt: '2026-08-20T02:30:00.000Z',
    });
  });
});
