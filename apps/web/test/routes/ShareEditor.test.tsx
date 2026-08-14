import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ShareEditor } from '../../src/routes/ShareEditor';
import { getShareEditorConfig } from '../../src/api/shares';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/shares', () => ({ getShareEditorConfig: vi.fn() }));

describe('ShareEditor', () => {
  const destroyEditor = vi.fn();

  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(getShareEditorConfig).mockResolvedValue({
      documentServerUrl: 'https://office.example.test',
      config: {},
    });
    window.DocsAPI = { DocEditor: vi.fn(() => ({ destroyEditor })) };
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete window.DocsAPI;
  });

  it('結束編輯時銷毀 OnlyOffice 工作階段並返回我的分享', async () => {
    render(<MemoryRouter initialEntries={['/shares/share-1/edit']}><Routes>
      <Route path="/shares/:id/edit" element={<ShareEditor />} />
      <Route path="/shares" element={<p>我的分享頁面</p>} />
    </Routes></MemoryRouter>);

    const script = await waitFor(() => {
      const element = document.querySelector('script[src*="office.example.test"]');
      expect(element).toBeInstanceOf(HTMLScriptElement);
      return element as HTMLScriptElement;
    });
    fireEvent.load(script);
    await waitFor(() => expect(window.DocsAPI?.DocEditor).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '結束編輯並返回我的分享' }));

    expect(destroyEditor).toHaveBeenCalledTimes(1);
    expect(screen.getByText('我的分享頁面')).toBeInTheDocument();
  });
});
