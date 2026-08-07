import { apiFetch } from './client';

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
}

export function searchUsers(query: string, accessToken: string) {
  return apiFetch<UserSummary[]>(`/users?search=${encodeURIComponent(query)}`, accessToken);
}
