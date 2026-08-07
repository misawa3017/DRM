import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { FolderView } from '../../src/routes/FolderView';
import { getFolder } from '../../src/api/folders';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({ getFolder: vi.fn(), createFolder: vi.fn() }));
vi.mock('../../src/api/documents', () => ({ uploadDocument: vi.fn() }));

describe('FolderView', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('renders child folders and documents for the given folder id', async () => {
    // parentId: null keeps Breadcrumb's ancestor walk a no-op for this test;
    // Breadcrumb's own walking behavior is covered by Breadcrumb.test.tsx.
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [
        { id: 'child-1', name: 'Q1', parentId: 'folder-1', createdBy: 'u', createdAt: '', canManage: false },
      ],
      documents: [{ id: 'doc-1', name: 'report.pdf', currentVersion: null, canManage: false }],
      canManage: false,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Q1' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'report.pdf' })).toBeInTheDocument();
    expect(getFolder).toHaveBeenCalledWith('folder-1', 'fake-token');
  });

  it('renders a link to the folder\'s permissions page when the caller can manage it', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() =>
      expect(screen.getByRole('link', { name: '權限' })).toHaveAttribute(
        'href',
        '/folders/folder-1/permissions',
      ),
    );
  });

  it('hides the permissions link when the caller can view but not manage the folder', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: false,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: '權限' })).not.toBeInTheDocument();
  });
});
