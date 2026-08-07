import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { DocumentView } from '../../src/routes/DocumentView';
import { getDocument, listVersions, downloadDocument } from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/documents', () => ({
  getDocument: vi.fn(),
  listVersions: vi.fn(),
  downloadDocument: vi.fn(),
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
        uploadedAt: '',
      },
    ]);
    const fakeBlob = new Blob(['data']);
    vi.mocked(downloadDocument).mockResolvedValue({ blob: fakeBlob, fileName: 'report.pdf' });

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    expect(screen.getByText('v2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('download-current'));

    await waitFor(() =>
      expect(downloadDocument).toHaveBeenCalledWith('doc-1', undefined, 'fake-token'),
    );
  });

  it('renders a link to the document\'s permissions page', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v2',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
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
});
