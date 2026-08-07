import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { PermissionsDashboard } from '../../src/routes/PermissionsDashboard';
import { listGlobalPermissions, revokePermission } from '../../src/api/permissions';
import { renderWithProviders } from '../testUtils';

function fakeJwt(payload: unknown): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.signature`;
}

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({
  listGlobalPermissions: vi.fn(),
  revokePermission: vi.fn(),
  grantPermission: vi.fn(),
}));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));

const directEntry = {
  id: 'p1',
  resourceType: 'folder' as const,
  resourceId: 'f1',
  principalType: 'user' as const,
  principalId: 'u1',
  permissionLevel: 'manage' as const,
  grantedBy: 'admin',
  grantedAt: '2026-08-01T00:00:00Z',
  principal: { email: 'a@example.com', displayName: 'Alice' },
  resourceName: '財務部',
  resourcePath: 'Root',
  source: 'direct' as const,
};

describe('PermissionsDashboard', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('loads with includeInherited=false by default', async () => {
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());
    expect(listGlobalPermissions).toHaveBeenCalledWith(false, 'fake-token');
  });

  it('explains that the list only shows resources the user manages, not everything granted to them', async () => {
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());
    expect(screen.getByText(/僅列出你可以管理的資源/)).toBeInTheDocument();
  });

  it('clicking "顯示繼承項目" refetches with includeInherited=true', async () => {
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('include-inherited-toggle'));

    await waitFor(() => expect(listGlobalPermissions).toHaveBeenCalledWith(true, 'fake-token'));
  });

  it('filters displayed entries by the search box against resource name and principal', async () => {
    const otherEntry = {
      ...directEntry,
      id: 'p2',
      resourceName: '人事資料',
      principal: { email: 'z@example.com', displayName: 'Zoe' },
    };
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry, otherEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());
    expect(screen.getByText('人事資料')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('permissions-filter-input'), { target: { value: '財務' } });

    expect(screen.getByText('財務部')).toBeInTheDocument();
    expect(screen.queryByText('人事資料')).not.toBeInTheDocument();
  });

  it("revokes the clicked row using that row's own resourceType/resourceId, not another row's", async () => {
    const documentEntry = {
      ...directEntry,
      id: 'p2',
      resourceType: 'document' as const,
      resourceId: 'd9',
      resourceName: '人事資料',
      principal: { email: 'z@example.com', displayName: 'Zoe' },
    };
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry, documentEntry]);
    vi.mocked(revokePermission).mockResolvedValue(undefined);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('人事資料')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('revoke-p2'));

    await waitFor(() =>
      expect(revokePermission).toHaveBeenCalledWith('document', 'd9', 'p2', 'fake-token'),
    );
    expect(revokePermission).not.toHaveBeenCalledWith('folder', 'f1', 'p1', 'fake-token');
  });

  it('shows a friendly error message and does not silently swallow a failed revoke', async () => {
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry]);
    vi.mocked(revokePermission).mockRejectedValue(new Error('boom'));

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('revoke-p1'));

    await waitFor(() => expect(screen.getByTestId('revoke-error')).toBeInTheDocument());
  });

  it('disables the "顯示繼承項目" toggle for admins, who already see everything', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: fakeJwt({ realm_access: { roles: ['admin'] } }) },
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());

    expect(screen.getByTestId('include-inherited-toggle')).toBeDisabled();
  });
});
