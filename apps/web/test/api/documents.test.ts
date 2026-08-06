import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadDocument, downloadDocument } from '../../src/api/documents';

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
});
