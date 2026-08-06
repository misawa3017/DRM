import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { RootFolders } from '../../src/routes/RootFolders';
import { listRootFolders } from '../../src/api/folders';
import { getRolesFromToken } from '../../src/lib/jwt';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  listRootFolders: vi.fn(),
  createFolder: vi.fn(),
}));
vi.mock('../../src/lib/jwt', () => ({ getRolesFromToken: vi.fn() }));

describe('RootFolders', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(getRolesFromToken).mockReturnValue([]);
  });

  it('renders a link for each visible root folder', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);

    renderWithProviders(<RootFolders />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Finance' })).toBeInTheDocument());
  });

  it('shows a helpful message when there are no visible root folders', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([]);

    renderWithProviders(<RootFolders />);

    await waitFor(() => expect(screen.getByTestId('empty')).toBeInTheDocument());
  });

  it('shows the "新增資料夾" button for admins', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([]);
    vi.mocked(getRolesFromToken).mockReturnValue(['admin']);

    renderWithProviders(<RootFolders />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '新增資料夾' })).toBeInTheDocument(),
    );
  });

  it('hides the "新增資料夾" button for non-admins', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([]);
    vi.mocked(getRolesFromToken).mockReturnValue(['user']);

    renderWithProviders(<RootFolders />);

    await waitFor(() => expect(screen.getByTestId('empty')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '新增資料夾' })).not.toBeInTheDocument();
  });
});
