import { apiFetch } from './client';

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string;
  createdAt: string;
  watermarkEnabled?: boolean | null;
  watermarkTemplate?: string | null;
}

export interface DocumentSummary {
  id: string;
  name: string;
  currentVersion: { id: string; versionNumber: number; sizeBytes: number; mimeType: string } | null;
  uploader?: {
    id: string;
    displayName: string;
    email: string;
  } | null;
}

export interface FolderChildSummary extends FolderSummary {
  canManage: boolean;
  canEdit: boolean;
}

export interface DocumentChildSummary extends DocumentSummary {
  canManage: boolean;
  canEdit: boolean;
}

export interface FolderDetail extends FolderSummary {
  children: FolderChildSummary[];
  documents: DocumentChildSummary[];
  // Whether the caller has manage-level access — GET /folders/:id only
  // requires 'view', a lower bar, so a caller can see the folder without
  // being allowed to see or edit its ACL. Gates the 權限 (ACL admin) link.
  canManage: boolean;
  // Whether the caller has edit-level access — the bar that actually gates
  // rename/move/delete affordances.
  canEdit: boolean;
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

export function renameFolder(id: string, name: string, accessToken: string) {
  return apiFetch<FolderSummary>(`/folders/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function moveFolder(id: string, parentId: string, accessToken: string) {
  return apiFetch<FolderSummary>(`/folders/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId }),
  });
}

export function deleteFolder(id: string, accessToken: string) {
  return apiFetch<void>(`/folders/${id}`, accessToken, { method: 'DELETE' });
}

export function updateFolderWatermark(
  id: string,
  watermarkEnabled: boolean | null,
  accessToken: string,
  watermarkTemplate?: string | null,
) {
  return apiFetch<FolderDetail>(`/folders/${id}/watermark`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      watermarkEnabled,
      ...(watermarkTemplate !== undefined && { watermarkTemplate }),
    }),
  });
}
