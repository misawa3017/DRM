import { apiFetch } from './client';

export type PermissionLevel = 'view' | 'download' | 'edit' | 'manage';

export interface PermissionEntry {
  id: string;
  resourceType: 'folder' | 'document';
  resourceId: string;
  principalType: 'user' | 'group';
  principalId: string;
  permissionLevel: PermissionLevel;
  grantedBy: string;
  grantedAt: string;
  principal: { email: string; displayName: string } | null;
}

export interface GlobalPermissionEntry extends PermissionEntry {
  resourceName: string;
  resourcePath: string;
  source: 'direct' | { inheritedFrom: { resourceId: string; resourceName: string } };
}

export function listPermissions(
  resourceType: 'folder' | 'document',
  resourceId: string,
  accessToken: string,
) {
  return apiFetch<PermissionEntry[]>(`/${resourceType}s/${resourceId}/permissions`, accessToken);
}

export function listGlobalPermissions(includeInherited: boolean, accessToken: string) {
  return apiFetch<GlobalPermissionEntry[]>(
    `/permissions?includeInherited=${includeInherited}`,
    accessToken,
  );
}

export function grantPermission(
  resourceType: 'folder' | 'document',
  resourceId: string,
  input: { principalId: string; permissionLevel: PermissionLevel },
  accessToken: string,
) {
  return apiFetch<PermissionEntry>(`/${resourceType}s/${resourceId}/permissions`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ principalType: 'user', ...input }),
  });
}

export function revokePermission(
  resourceType: 'folder' | 'document',
  resourceId: string,
  permissionId: string,
  accessToken: string,
) {
  return apiFetch<void>(
    `/${resourceType}s/${resourceId}/permissions/${permissionId}`,
    accessToken,
    { method: 'DELETE' },
  );
}
