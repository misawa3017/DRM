import { apiFetch, ApiError } from './client';

export interface DocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface DocumentDetail {
  id: string;
  folderId: string;
  name: string;
  currentVersionId: string | null;
  currentVersion: DocumentVersion | null;
  createdBy: string;
  createdAt: string;
  expiresAt?: string | null;
  status?: 'active' | 'expired';
  watermarkEnabled?: boolean | null;
  watermarkTemplate?: string | null;
  // Whether the caller has manage-level access — GET /documents/:id only
  // requires 'view', a lower bar, so a caller can see the document without
  // being allowed to see or edit its ACL. Gates the 權限 (ACL admin) link.
  canManage: boolean;
  // Whether the caller has edit-level access — the bar that actually gates
  // rename/move/delete/upload-version affordances.
  canEdit: boolean;
}

export function getDocument(id: string, accessToken: string) {
  return apiFetch<DocumentDetail>(`/documents/${id}`, accessToken);
}

export function listVersions(id: string, accessToken: string) {
  return apiFetch<DocumentVersion[]>(`/documents/${id}/versions`, accessToken);
}

export function uploadDocument(
  input: { folderId: string; name: string; file: File },
  accessToken: string,
) {
  const form = new FormData();
  form.append('folderId', input.folderId);
  form.append('name', input.name);
  form.append('file', input.file);
  return apiFetch<DocumentDetail>('/documents', accessToken, { method: 'POST', body: form });
}

export function uploadVersion(documentId: string, file: File, accessToken: string) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch<DocumentVersion>(`/documents/${documentId}/versions`, accessToken, {
    method: 'POST',
    body: form,
  });
}

export async function downloadDocument(
  documentId: string,
  versionId: string | undefined,
  accessToken: string,
): Promise<{ blob: Blob; fileName: string }> {
  const query = versionId ? `?versionId=${versionId}` : '';
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL}/documents/${documentId}/download${query}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new ApiError(response.status, `Download failed with status ${response.status}`);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const fileName = match ? match[1] : 'download';
  const blob = await response.blob();
  return { blob, fileName };
}

export async function previewDocument(documentId: string, accessToken: string): Promise<Blob> {
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL}/documents/${documentId}/preview`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new ApiError(response.status, `Preview failed with status ${response.status}`);
  }
  return response.blob();
}

export function renameDocument(id: string, name: string, accessToken: string) {
  return apiFetch<DocumentDetail>(`/documents/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function moveDocument(id: string, folderId: string, accessToken: string) {
  return apiFetch<DocumentDetail>(`/documents/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
  });
}

export function deleteDocument(id: string, accessToken: string) {
  return apiFetch<void>(`/documents/${id}`, accessToken, { method: 'DELETE' });
}

export function updateDocumentWatermark(
  id: string,
  watermarkEnabled: boolean | null,
  accessToken: string,
  watermarkTemplate?: string | null,
) {
  return apiFetch<DocumentDetail>(`/documents/${id}/watermark`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      watermarkEnabled,
      ...(watermarkTemplate !== undefined && { watermarkTemplate }),
    }),
  });
}

export function updateDocumentExpiration(
  id: string,
  expiresAt: string | null,
  accessToken: string,
) {
  return apiFetch<DocumentDetail>(`/documents/${id}/expiration`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt }),
  });
}
