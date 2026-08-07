import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { PermissionsDashboard } from '../../src/routes/PermissionsDashboard';
import { listGlobalPermissions } from '../../src/api/permissions';
import { renderWithProviders } from '../testUtils';

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
});
