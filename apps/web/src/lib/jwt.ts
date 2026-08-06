/**
 * Best-effort, client-side decode of a JWT's roles claim, used only to
 * decide what to *show* (e.g. hiding a button that would 403 for non-admins).
 * This is a UI convenience, not a security boundary — the backend
 * (`FoldersService.create`, see `apps/api/src/folders/folders.service.ts`)
 * is the actual enforcement point and re-checks authorization itself.
 */
export function getRolesFromToken(accessToken: string): string[] {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return [];

  try {
    const payloadSegment = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadSegment.padEnd(
      payloadSegment.length + ((4 - (payloadSegment.length % 4)) % 4),
      '=',
    );
    const json = atob(padded);
    const payload = JSON.parse(json) as { realm_access?: { roles?: string[] } };
    return payload.realm_access?.roles ?? [];
  } catch {
    return [];
  }
}
