import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchUsers } from '../../src/api/users';

describe('users api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('searchUsers calls GET /users with the query string, URL-encoded', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [{ id: '1', email: 'a@b.com', displayName: 'A', department: null }],
    } as Response);

    const result = await searchUsers('王 志成', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/users?search=');
    expect(url).toContain(encodeURIComponent('王 志成'));
    expect(result).toEqual([{ id: '1', email: 'a@b.com', displayName: 'A', department: null }]);
  });
});
