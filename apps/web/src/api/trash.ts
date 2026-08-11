import { apiFetch } from './client';

export interface TrashItem {
  id: string;
  name: string;
  parentId?: string | null;
  folderId?: string;
  createdAt: string;
  deletedAt: string;
  resourceType: 'folder' | 'document';
}

export function listTrash(accessToken: string) {
  return apiFetch<TrashItem[]>('/trash', accessToken);
}

export function restoreTrashItem(item: TrashItem, accessToken: string) {
  return apiFetch<void>(`/trash/${item.resourceType}s/${item.id}/restore`, accessToken, {
    method: 'POST',
  });
}

export function purgeTrashItem(item: TrashItem, accessToken: string) {
  return apiFetch<void>(`/trash/${item.resourceType}s/${item.id}`, accessToken, {
    method: 'DELETE',
  });
}
