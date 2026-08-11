import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { Trash } from '../../src/routes/Trash';
import { listTrash, purgeTrashItem, restoreTrashItem, type TrashItem } from '../../src/api/trash';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/trash', () => ({
  listTrash: vi.fn(),
  restoreTrashItem: vi.fn(),
  purgeTrashItem: vi.fn(),
}));

const items: TrashItem[] = [
  {
    id: 'folder-1',
    name: '財務資料夾',
    parentId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    deletedAt: '2026-08-11T00:00:00.000Z',
    resourceType: 'folder',
  },
  {
    id: 'document-1',
    name: '報表.pdf',
    folderId: 'folder-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    deletedAt: '2026-08-11T00:00:00.000Z',
    resourceType: 'document',
  },
];

describe('Trash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'test-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('顯示載入中與空垃圾桶狀態', async () => {
    let resolveItems: (value: TrashItem[]) => void;
    vi.mocked(listTrash).mockReturnValueOnce(new Promise((resolve) => { resolveItems = resolve; }));

    renderWithProviders(<Trash />);

    expect(screen.getByTestId('trash-loading')).toBeInTheDocument();
    resolveItems!([]);
    expect(await screen.findByText('垃圾桶是空的')).toBeInTheDocument();
    expect(listTrash).toHaveBeenCalledWith('test-token');
  });

  it('可還原資料夾與文件，並重新取得垃圾桶清單', async () => {
    vi.mocked(listTrash).mockResolvedValue(items);
    vi.mocked(restoreTrashItem).mockResolvedValue(undefined);

    renderWithProviders(<Trash />);

    expect(await screen.findByText('財務資料夾')).toBeInTheDocument();
    expect(screen.getByText('資料夾（含其內容）')).toBeInTheDocument();
    expect(screen.getByText('文件')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '還原' })[0]);
    await waitFor(() =>
      expect(restoreTrashItem).toHaveBeenCalledWith(items[0], 'test-token'),
    );
    await waitFor(() => expect(listTrash).toHaveBeenCalledTimes(2));
  });

  it('確認後可永久清除文件，並重新取得垃圾桶清單', async () => {
    vi.mocked(listTrash).mockResolvedValue(items);
    vi.mocked(purgeTrashItem).mockResolvedValue(undefined);

    renderWithProviders(<Trash />);

    expect(await screen.findByText('報表.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '永久清除 報表.pdf' }));
    expect(await screen.findByText('永久清除「報表.pdf」？')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(purgeTrashItem).toHaveBeenCalledWith(items[1], 'test-token'));
    await waitFor(() => expect(listTrash).toHaveBeenCalledTimes(2));
  });
});
