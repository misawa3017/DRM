import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { FolderPermissions } from '../../src/routes/FolderPermissions';
import { listPermissions, revokePermission } from '../../src/api/permissions';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({
  listPermissions: vi.fn(),
  revokePermission: vi.fn(),
  grantPermission: vi.fn(),
}));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));

describe('FolderPermissions', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('lists permissions for the folder id from the route and revokes one on click', async () => {
    vi.mocked(listPermissions).mockResolvedValue([
      {
        id: 'p1',
        resourceType: 'folder',
        resourceId: 'folder-1',
        principalType: 'user',
        principalId: 'u1',
        permissionLevel: 'view',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'a@example.com', displayName: 'Alice' },
      },
    ]);
    vi.mocked(revokePermission).mockResolvedValue(undefined);

    renderWithProviders(<FolderPermissions />, {
      route: '/folders/folder-1/permissions',
      path: '/folders/:id/permissions',
    });

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(listPermissions).toHaveBeenCalledWith('folder', 'folder-1', 'fake-token');

    fireEvent.click(screen.getByTestId('revoke-p1'));
    await waitFor(() =>
      expect(revokePermission).toHaveBeenCalledWith('folder', 'folder-1', 'p1', 'fake-token'),
    );
  });
});
