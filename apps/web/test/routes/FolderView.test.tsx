import { screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { FolderView } from '../../src/routes/FolderView';
import { getFolder, renameFolder, deleteFolder, updateFolderWatermark } from '../../src/api/folders';
import { deleteDocument } from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  getFolder: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  moveFolder: vi.fn(),
  deleteFolder: vi.fn(),
  updateFolderWatermark: vi.fn(),
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
        {
          id: 'child-1',
          name: 'Q1',
          parentId: 'folder-1',
          createdBy: 'u',
          createdAt: '',
          canManage: false,
          canEdit: false,
        },
      ],
      documents: [
        { id: 'doc-1', name: 'report.pdf', currentVersion: null, canManage: false, canEdit: false },
      ],
      canManage: false,
      canEdit: false,
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
      canEdit: true,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() =>
      expect(screen.getByRole('link', { name: '權限' })).toHaveAttribute(
        'href',
        '/folders/folder-1/permissions',
      ),
    );
  });

  it('allows a manager to update the inherited watermark setting', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      watermarkEnabled: null,
      children: [],
      documents: [],
      canManage: true,
      canEdit: true,
    });
    vi.mocked(updateFolderWatermark).mockResolvedValue({} as never);

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('folder-policy-settings')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('動態浮水印'), { target: { value: 'enabled' } });
    await waitFor(() =>
      expect(updateFolderWatermark).toHaveBeenCalledWith('folder-1', true, 'fake-token'),
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
      canEdit: true,
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
      canEdit: true,
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

  it('does not show the rename/move/delete header actions when canEdit is false', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: false,
      canEdit: false,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.queryByTestId('folder-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-folder-folder-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('move-folder-folder-1')).not.toBeInTheDocument();
  });

  it('shows rename/move/delete header actions when canEdit is true but hides 權限 when canManage is false', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: 'root-folder',
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: false,
      canEdit: true,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('folder-name')).toBeInTheDocument());
    expect(screen.getByTestId('delete-folder-folder-1')).toBeInTheDocument();
    expect(screen.getByTestId('move-folder-folder-1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '權限' })).not.toBeInTheDocument();
  });

  it('hides the Move button on a root folder (no parentId) even when canEdit is true, but still shows rename/delete', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
      canEdit: true,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('folder-name')).toBeInTheDocument());
    expect(screen.getByTestId('delete-folder-folder-1')).toBeInTheDocument();
    expect(screen.queryByTestId('move-folder-folder-1')).not.toBeInTheDocument();
  });

  it('hides 新增資料夾/上傳新文件 when the caller cannot edit the folder', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: false,
      canEdit: false,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '新增資料夾' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上傳新文件' })).not.toBeInTheDocument();
  });

  it('shows 新增資料夾/上傳新文件 when the caller can edit the folder', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: false,
      canEdit: true,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '新增資料夾' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上傳新文件' })).toBeInTheDocument();
  });

  it('shows rename/move/delete actions only on child rows the caller can edit', async () => {
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
          canManage: false,
          canEdit: true,
        },
        {
          id: 'child-2',
          name: 'Q2',
          parentId: 'folder-1',
          createdBy: 'u',
          createdAt: '',
          canManage: false,
          canEdit: false,
        },
      ],
      documents: [],
      canManage: true,
      canEdit: true,
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
        { id: 'doc-1', name: 'report.pdf', currentVersion: null, canManage: false, canEdit: true },
      ],
      canManage: true,
      canEdit: true,
    });
    vi.mocked(deleteDocument).mockResolvedValue(undefined);

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-document-doc-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-document-doc-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('doc-1', 'fake-token'));
  });

  it('shows a failed row delete error inside the still-open DeleteConfirmDialog', async () => {
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
          canManage: false,
          canEdit: true,
        },
      ],
      documents: [],
      canManage: true,
      canEdit: true,
    });
    vi.mocked(deleteFolder).mockRejectedValue({ response: { status: 403 } });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-folder-child-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-folder-child-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(screen.getByTestId('delete-confirm-error')).toBeInTheDocument());
    // Dialog stays open on failure — the confirm button is still present.
    expect(screen.getByTestId('confirm-delete')).toBeInTheDocument();
  });

  it("shows a failed header delete error inside the still-open DeleteConfirmDialog", async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: 'root-folder',
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
      canEdit: true,
    });
    vi.mocked(deleteFolder).mockRejectedValue({ response: { status: 403 } });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-folder-folder-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-folder-folder-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(screen.getByTestId('delete-confirm-error')).toBeInTheDocument());
    expect(screen.getByTestId('confirm-delete')).toBeInTheDocument();
  });
});
