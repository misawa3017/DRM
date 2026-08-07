import { apiFetch } from './client';

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface DocumentSummary {
  id: string;
  name: string;
  currentVersion: { id: string; versionNumber: number; sizeBytes: number; mimeType: string } | null;
}

export interface FolderDetail extends FolderSummary {
  children: FolderSummary[];
  documents: DocumentSummary[];
  // Whether the caller has manage-level access — GET /folders/:id only
  // requires 'view', a lower bar, so a caller can see the folder without
  // being allowed to see or edit its ACL.
  canManage: boolean;
}

export function listRootFolders(accessToken: string) {
  return apiFetch<FolderSummary[]>('/folders', accessToken);
}

export function getFolder(id: string, accessToken: string) {
  return apiFetch<FolderDetail>(`/folders/${id}`, accessToken);
}

export function createFolder(
  input: { name: string; parentId: string | null },
  accessToken: string,
) {
  return apiFetch<FolderSummary>('/folders', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, parentId: input.parentId }),
  });
}
