import { ApiError } from '../api/client';

// A 4xx means the request itself is invalid for this user (no permission,
// not found, etc.) — retrying with the same token and resource id will
// never succeed, it only delays the error by several seconds of
// exponential backoff and makes a correct "forbidden" response look like
// a hang.
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 3;
}
