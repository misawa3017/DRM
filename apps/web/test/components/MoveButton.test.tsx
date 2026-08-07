import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { MoveButton } from '../../src/components/MoveButton';
import { listRootFolders, getFolder, moveFolder } from '../../src/api/folders';
import { moveDocument } from '../../src/api/documents';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  listRootFolders: vi.fn(),
  getFolder: vi.fn(),
  moveFolder: vi.fn(),
}));
vi.mock('../../src/api/documents', () => ({ moveDocument: vi.fn() }));

function renderMoveButton(props: Partial<Parameters<typeof MoveButton>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onMoved = vi.fn();
  return {
    onMoved,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MoveButton resourceType="folder" resourceId="f1" onMoved={onMoved} {...props} />
      </QueryClientProvider>,
    ),
  };
}

describe('MoveButton', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('opens the folder-only ResourcePicker and calls moveFolder with the chosen destination', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f2', name: 'Destination', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f2',
      name: 'Destination',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });
    vi.mocked(moveFolder).mockResolvedValue({
      id: 'f1',
      name: 'Moved',
      parentId: 'f2',
      createdBy: 'u',
      createdAt: '',
    });

    const { onMoved } = renderMoveButton();

    fireEvent.click(screen.getByTestId('move-folder-f1'));
    await waitFor(() => expect(screen.getByText('Destination')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Destination'));
    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    await waitFor(() => expect(moveFolder).toHaveBeenCalledWith('f1', 'f2', 'fake-token'));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });

  it('calls moveDocument (not moveFolder) when resourceType is document', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f2', name: 'Destination', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f2',
      name: 'Destination',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });
    vi.mocked(moveDocument).mockResolvedValue({
      id: 'd1',
      folderId: 'f2',
      name: 'doc.txt',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
    });

    renderMoveButton({ resourceType: 'document', resourceId: 'd1' });

    fireEvent.click(screen.getByTestId('move-document-d1'));
    await waitFor(() => expect(screen.getByText('Destination')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Destination'));
    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    await waitFor(() => expect(moveDocument).toHaveBeenCalledWith('d1', 'f2', 'fake-token'));
  });

  it('shows a friendly error message when the move fails', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f2', name: 'Destination', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f2',
      name: 'Destination',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });
    vi.mocked(moveFolder).mockRejectedValue(new Error('boom'));

    renderMoveButton();

    fireEvent.click(screen.getByTestId('move-folder-f1'));
    await waitFor(() => expect(screen.getByText('Destination')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Destination'));
    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    await waitFor(() => expect(screen.getByText('發生錯誤，請稍後再試')).toBeInTheDocument());
  });
});
