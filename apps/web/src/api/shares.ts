import { apiFetch } from './client';

export interface ReceivedShare {
  id: string;
  documentId: string;
  accessLevel: 'view' | 'edit';
  expiresAt: string;
  maskRules: unknown[] | null;
  document: { name: string };
}

export function listReceivedShares(accessToken: string) {
  return apiFetch<ReceivedShare[]>('/shares/received', accessToken);
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
