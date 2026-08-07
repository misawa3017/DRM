import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { ResourcePicker } from '../../src/components/ResourcePicker';
import { listRootFolders, getFolder } from '../../src/api/folders';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  listRootFolders: vi.fn(),
  getFolder: vi.fn(),
}));

function renderPicker(onSelect = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onSelect,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={onSelect} />
      </QueryClientProvider>,
    ),
  };
}

describe('ResourcePicker', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('shows root folders and lets the user drill into one', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [{ id: 'f2', name: 'Q1', parentId: 'f1', createdBy: 'u', createdAt: '' }],
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null }],
    });

    renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByText('Q1')).toBeInTheDocument());
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('calls onSelect with resourceType folder when "選擇這個資料夾" is clicked', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
    });

    const { onSelect } = renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    expect(onSelect).toHaveBeenCalledWith({ resourceType: 'folder', resourceId: 'f1', name: 'Finance' });
  });

  it('calls onSelect with resourceType document when a document is clicked', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null }],
    });

    const { onSelect } = renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    fireEvent.click(screen.getByText('report.pdf'));

    expect(onSelect).toHaveBeenCalledWith({ resourceType: 'document', resourceId: 'd1', name: 'report.pdf' });
  });
});
