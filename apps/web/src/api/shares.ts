import { apiFetch } from './client';

export interface ReceivedShare {
  id: string;
  documentId: string;
  accessLevel: 'view' | 'edit';
  expiresAt: string;
  maskRules: unknown[] | null;
  document: { name: string };
}

export type ShareAccessLevel = 'view' | 'edit';
export type MaskMode = 'redact' | 'partial';

export interface MaskRule {
  sheetName: string;
  header: string;
  mode: MaskMode;
}

export interface DocumentShare {
  id: string;
  recipientId: string;
  createdBy: string;
  accessLevel: ShareAccessLevel;
  expiresAt: string;
  revokedAt: string | null;
  maskRules: MaskRule[] | null;
  recipient: { id: string; displayName: string; email: string } | null;
  createdAt: string;
}

export interface CreateDocumentShareInput {
  recipientId: string;
  accessLevel: ShareAccessLevel;
  durationHours: number;
  maskRules?: MaskRule[];
}

export function listReceivedShares(accessToken: string) {
  return apiFetch<ReceivedShare[]>('/shares/received', accessToken);
}

export function listDocumentShares(documentId: string, accessToken: string) {
  return apiFetch<DocumentShare[]>(`/documents/${documentId}/shares`, accessToken);
}

export function createDocumentShare(documentId: string, input: CreateDocumentShareInput, accessToken: string) {
  return apiFetch<DocumentShare>(`/documents/${documentId}/shares`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updateDocumentShare(
  shareId: string,
  input: Partial<Pick<CreateDocumentShareInput, 'accessLevel' | 'durationHours'>>,
  accessToken: string,
) {
  return apiFetch<DocumentShare>(`/shares/${shareId}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function revokeDocumentShare(shareId: string, accessToken: string) {
  return apiFetch<void>(`/shares/${shareId}`, accessToken, { method: 'DELETE' });
}

export async function downloadSharedDocument(shareId: string, accessToken: string) {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/shares/${shareId}/download`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
  return response.blob();
}

export function getShareEditorConfig(shareId: string, accessToken: string) {
  return apiFetch<{ documentServerUrl: string; config: Record<string, unknown> }>(`/shares/${shareId}/editor-config`, accessToken);
}
