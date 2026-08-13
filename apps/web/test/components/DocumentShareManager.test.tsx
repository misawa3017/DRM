import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { DocumentShareManager } from '../../src/components/DocumentShareManager';
import { createDocumentShare, listDocumentShares } from '../../src/api/shares';
import { searchUsers } from '../../src/api/users';

vi.mock('../../src/api/shares', () => ({
  createDocumentShare: vi.fn(),
  listDocumentShares: vi.fn(),
  revokeDocumentShare: vi.fn(),
  updateDocumentShare: vi.fn(),
}));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));

function renderManager() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><DocumentShareManager documentId="doc-1" mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" accessToken="token" /></QueryClientProvider>);
}

describe('DocumentShareManager', () => {
  it('建立含遮蔽規則的限時分享', async () => {
    vi.mocked(listDocumentShares).mockResolvedValue([]);
    vi.mocked(searchUsers).mockResolvedValue([{ id: 'user-2', displayName: '王小明', email: 'ming@example.com', department: null }]);
    vi.mocked(createDocumentShare).mockResolvedValue({ id: 'share-1' } as never);
    renderManager();

    fireEvent.click(screen.getByRole('button', { name: '限時分享' }));
    fireEvent.change(screen.getByLabelText('搜尋收件者'), { target: { value: '王小明' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    await waitFor(() => expect(screen.getByText('王小明')).toBeInTheDocument());
    fireEvent.click(screen.getByText('王小明'));
    fireEvent.change(screen.getByLabelText('有效時數'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('工作表名稱'), { target: { value: '員工資料' } });
    fireEvent.change(screen.getByLabelText('欄位名稱'), { target: { value: '身分證字號' } });
    fireEvent.click(screen.getByRole('button', { name: '新增欄位' }));
    fireEvent.click(screen.getByRole('button', { name: '建立分享' }));

    await waitFor(() => expect(createDocumentShare).toHaveBeenCalledWith('doc-1', {
      recipientId: 'user-2', accessLevel: 'view', durationHours: 12,
      maskRules: [{ sheetName: '員工資料', header: '身分證字號', mode: 'redact' }],
    }, 'token'));
  });

  it('非 xlsx 文件會顯示不支援訊息', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><DocumentShareManager documentId="doc-1" mimeType="application/pdf" accessToken="token" /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '限時分享' }));
    expect(screen.getByText('限時分享目前僅支援 .xlsx Excel 檔案。')).toBeInTheDocument();
  });
});
