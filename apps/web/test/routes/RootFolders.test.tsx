import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { RootFolders } from '../../src/routes/RootFolders';
import { listRootFolders } from '../../src/api/folders';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  listRootFolders: vi.fn(),
  createFolder: vi.fn(),
}));

describe('RootFolders', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
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
});
