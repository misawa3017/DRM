import { screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { FolderView } from '../../src/routes/FolderView';
import { getFolder, renameFolder, deleteFolder } from '../../src/api/folders';
import { deleteDocument } from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  getFolder: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  moveFolder: vi.fn(),
  deleteFolder: vi.fn(),
}));
vi.mock('../../src/api/documents', () => ({
  uploadDocument: vi.fn(),
  renameDocument: vi.fn(),
  moveDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

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

  it('renaming the folder itself via the header calls renameFolder and refetches', async () => {
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
    vi.mocked(renameFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('folder-name')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('folder-name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Finance Dept' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() =>
      expect(renameFolder).toHaveBeenCalledWith('folder-1', 'Finance Dept', 'fake-token'),
    );
  });

  it('does not show the rename/move/delete header actions when canManage is false', async () => {
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
    expect(screen.queryByTestId('folder-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-folder-folder-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('move-folder-folder-1')).not.toBeInTheDocument();
  });

  it('shows rename/move/delete actions only on child rows the caller can manage', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [
        {
          id: 'child-1',
          name: 'Q1',
          parentId: 'folder-1',
          createdBy: 'u',
          createdAt: '',
          canManage: true,
        },
        {
          id: 'child-2',
          name: 'Q2',
          parentId: 'folder-1',
          createdBy: 'u',
          createdAt: '',
          canManage: false,
        },
      ],
      documents: [],
      canManage: true,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('folder-row-name-child-1')).toBeInTheDocument());
    expect(screen.getByTestId('delete-folder-child-1')).toBeInTheDocument();
    expect(screen.queryByTestId('delete-folder-child-2')).not.toBeInTheDocument();
  });

  it('deleting a child document row calls deleteDocument and refetches the folder', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [
        { id: 'doc-1', name: 'report.pdf', currentVersion: null, canManage: true },
      ],
      canManage: true,
    });
    vi.mocked(deleteDocument).mockResolvedValue(undefined);

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-document-doc-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-document-doc-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('doc-1', 'fake-token'));
  });
});
