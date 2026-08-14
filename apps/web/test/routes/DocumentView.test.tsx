import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { DocumentView } from '../../src/routes/DocumentView';
import {
  getDocument,
  listVersions,
  getDocumentDownloadResponse,
  renameDocument,
  deleteDocument,
  updateDocumentExpiration,
  updateDocumentWatermark,
} from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/documents', () => ({
  getDocument: vi.fn(),
  listVersions: vi.fn(),
  getDocumentDownloadResponse: vi.fn(),
  renameDocument: vi.fn(),
  moveDocument: vi.fn(),
  deleteDocument: vi.fn(),
  updateDocumentExpiration: vi.fn(),
  updateDocumentWatermark: vi.fn(),
}));

describe('DocumentView', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders document metadata and version history, and downloads on click', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v2',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: false,
      canEdit: false,
    });
    vi.mocked(listVersions).mockResolvedValue([
      {
        id: 'v2',
        documentId: 'doc-1',
        versionNumber: 2,
        sha256: 'x',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedBy: 'user-1',
        uploader: {
          id: 'user-1',
          displayName: '王小明',
          email: 'ming@example.com',
        },
        uploadedAt: '',
      },
    ]);
    vi.mocked(getDocumentDownloadResponse).mockResolvedValue(new Response('data'));

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('王小明')).toBeInTheDocument();
    expect(screen.getByText('ming@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('download-current'));

    await waitFor(() =>
      expect(getDocumentDownloadResponse).toHaveBeenCalledWith('doc-1', undefined, 'fake-token'),
    );
  });

  it('renders a link to the document\'s permissions page when the caller can manage it', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v2',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
      canEdit: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() =>
      expect(screen.getByRole('link', { name: '權限' })).toHaveAttribute(
        'href',
        '/documents/doc-1/permissions',
      ),
    );
  });

  it('allows a manager to update watermark and expiration settings', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      watermarkEnabled: null,
      watermarkTemplate: null,
      expiresAt: null,
      status: 'active',
      canManage: true,
      canEdit: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(updateDocumentWatermark).mockResolvedValue({} as never);
    vi.mocked(updateDocumentExpiration).mockResolvedValue({} as never);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByTestId('document-policy-settings')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('動態浮水印'), { target: { value: 'disabled' } });
    await waitFor(() =>
      expect(updateDocumentWatermark).toHaveBeenCalledWith('doc-1', false, 'fake-token'),
    );

    fireEvent.change(screen.getByLabelText('浮水印內容來源'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('浮水印範本'), {
      target: { value: '機密｜{{email}}｜{{documentName}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '儲存範本' }));
    await waitFor(() =>
      expect(updateDocumentWatermark).toHaveBeenCalledWith(
        'doc-1',
        null,
        'fake-token',
        '機密｜{{email}}｜{{documentName}}',
      ),
    );

    fireEvent.change(screen.getByLabelText('到期時間'), {
      target: { value: '2026-08-20T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() =>
      expect(updateDocumentExpiration).toHaveBeenCalledWith(
        'doc-1',
        new Date('2026-08-20T10:30').toISOString(),
        'fake-token',
      ),
    );
  });

  it("hides the permissions link when the caller can view but not manage the document", async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v2',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: false,
      canEdit: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: '權限' })).not.toBeInTheDocument();
  });

  it('renaming the document via the header calls renameDocument and refetches', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
      canEdit: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(renameDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
      canEdit: true,
    });

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByTestId('document-name')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('document-name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'renamed.pdf' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() =>
      expect(renameDocument).toHaveBeenCalledWith('doc-1', 'renamed.pdf', 'fake-token'),
    );
  });

  it('does not show the rename/move/delete header actions when canEdit is false', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: false,
      canEdit: false,
    });
    vi.mocked(listVersions).mockResolvedValue([]);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    expect(screen.queryByTestId('document-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-document-doc-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('move-document-doc-1')).not.toBeInTheDocument();
  });

  it('shows rename/move/delete header actions when canEdit is true but hides 權限 when canManage is false', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: false,
      canEdit: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByTestId('document-name')).toBeInTheDocument());
    expect(screen.getByTestId('delete-document-doc-1')).toBeInTheDocument();
    expect(screen.getByTestId('move-document-doc-1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '權限' })).not.toBeInTheDocument();
  });

  it('deleting the document via the header calls deleteDocument', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
      canEdit: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(deleteDocument).mockResolvedValue(undefined);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-document-doc-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-document-doc-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('doc-1', 'fake-token'));
  });

  it('shows a failed header delete error inside the still-open DeleteConfirmDialog', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
      canEdit: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(deleteDocument).mockRejectedValue({ response: { status: 403 } });

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-document-doc-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-document-doc-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(screen.getByTestId('delete-confirm-error')).toBeInTheDocument());
    expect(screen.getByTestId('confirm-delete')).toBeInTheDocument();
  });
});
