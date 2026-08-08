import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchResources } from '../../src/api/search';

describe('search api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('searchResources GETs /search with the URL-encoded query', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [
        { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
      ],
    } as Response);

    const result = await searchResources('finance report', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/search?q=finance%20report');
    expect(result).toEqual([
      { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
    ]);
  });
});
