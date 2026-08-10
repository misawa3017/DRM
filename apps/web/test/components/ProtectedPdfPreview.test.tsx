import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProtectedPdfPreview } from '../../src/components/ProtectedPdfPreview';
import { previewDocument } from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('../../src/api/documents', () => ({ previewDocument: vi.fn() }));

describe('ProtectedPdfPreview', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:protected-pdf'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('only downloads and displays the protected PDF after the user opens preview', async () => {
    vi.mocked(previewDocument).mockResolvedValue(
      new Blob(['protected'], { type: 'application/pdf' }),
    );
    renderWithProviders(<ProtectedPdfPreview documentId="doc-1" accessToken="fake-token" />);

    expect(previewDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '開啟預覽' }));

    await waitFor(() =>
      expect(previewDocument).toHaveBeenCalledWith('doc-1', 'fake-token'),
    );
    expect(await screen.findByTitle('受保護的 PDF 預覽')).toHaveAttribute(
      'src',
      'blob:protected-pdf#toolbar=0&navpanes=0',
    );
  });
});
