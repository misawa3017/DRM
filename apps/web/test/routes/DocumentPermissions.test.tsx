import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { DocumentPermissions } from '../../src/routes/DocumentPermissions';
import { listPermissions } from '../../src/api/permissions';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({
  listPermissions: vi.fn(),
  revokePermission: vi.fn(),
  grantPermission: vi.fn(),
}));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));

describe('DocumentPermissions', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('lists permissions for the document id from the route', async () => {
    vi.mocked(listPermissions).mockResolvedValue([]);

    renderWithProviders(<DocumentPermissions />, {
      route: '/documents/doc-1/permissions',
      path: '/documents/:id/permissions',
    });

    await waitFor(() =>
      expect(listPermissions).toHaveBeenCalledWith('document', 'doc-1', 'fake-token'),
    );
  });
});
