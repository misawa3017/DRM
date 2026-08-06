import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError, friendlyErrorMessage } from '../../src/api/client';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('sends the Authorization header and decodes JSON on success', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ hello: 'world' }),
    } as Response);

    const result = await apiFetch<{ hello: string }>('/whoami', 'fake-token');

    expect(result).toEqual({ hello: 'world' });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fake-token');
  });

  it('throws ApiError with the response status on non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(apiFetch('/folders', 'fake-token')).rejects.toMatchObject({ status: 403 });
  });
});

describe('friendlyErrorMessage', () => {
  it('maps 403 to a permission message', () => {
    expect(friendlyErrorMessage(new ApiError(403, 'x'))).toContain('權限');
  });

  it('maps 404 to a not-found message', () => {
    expect(friendlyErrorMessage(new ApiError(404, 'x'))).toContain('找不到');
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(friendlyErrorMessage(new Error('boom'))).toBe('發生錯誤，請稍後再試');
  });
});
