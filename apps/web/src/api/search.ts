import { apiFetch } from './client';

export interface SearchResultItem {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  path: string;
}

export function searchResources(query: string, accessToken: string) {
  return apiFetch<SearchResultItem[]>(`/search?q=${encodeURIComponent(query)}`, accessToken);
}
