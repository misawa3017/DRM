import { describe, it, expect } from 'vitest';
import { shouldRetryQuery } from '../../src/lib/queryRetry';
import { ApiError } from '../../src/api/client';

describe('shouldRetryQuery', () => {
  it('never retries a 403 (forbidden), which cannot succeed on retry', () => {
    expect(shouldRetryQuery(0, new ApiError(403, 'forbidden'))).toBe(false);
  });

  it('never retries a 404 (not found)', () => {
    expect(shouldRetryQuery(0, new ApiError(404, 'not found'))).toBe(false);
  });

  it('retries a 500 up to the default 3 attempts', () => {
    expect(shouldRetryQuery(0, new ApiError(500, 'server error'))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError(500, 'server error'))).toBe(true);
    expect(shouldRetryQuery(3, new ApiError(500, 'server error'))).toBe(false);
  });

  it('retries a plain network error (not an ApiError) up to 3 attempts', () => {
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(3, new TypeError('Failed to fetch'))).toBe(false);
  });
});
