import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { UploadDialog } from '../../src/components/UploadDialog';
import { uploadDocument, uploadVersion } from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/documents', () => ({
  uploadDocument: vi.fn(),
  uploadVersion: vi.fn(),
}));

describe('UploadDialog', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('mode=new-document calls uploadDocument with the selected file and folderId', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v1',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: false,
      canEdit: false,
    });

    renderWithProviders(<UploadDialog mode="new-document" folderId="folder-1" />);

    fireEvent.click(screen.getByRole('button', { name: '上傳新文件' }));
    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByTestId('submit-upload'));

    await waitFor(() =>
      expect(uploadDocument).toHaveBeenCalledWith(
        { folderId: 'folder-1', name: 'report.pdf', file },
        'fake-token',
      ),
    );
  });

  it('mode=new-version calls uploadVersion with the selected file and documentId', async () => {
    vi.mocked(uploadVersion).mockResolvedValue({
      id: 'v2',
      documentId: 'doc-1',
      versionNumber: 2,
      sha256: 'x',
      mimeType: 'application/pdf',
      sizeBytes: 1,
      uploadedBy: 'u',
      uploadedAt: '',
    });

    renderWithProviders(<UploadDialog mode="new-version" documentId="doc-1" />);

    fireEvent.click(screen.getByRole('button', { name: '上傳新版本' }));
    const file = new File(['content'], 'v2.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByTestId('submit-upload'));

    await waitFor(() => expect(uploadVersion).toHaveBeenCalledWith('doc-1', file, 'fake-token'));
  });
});
