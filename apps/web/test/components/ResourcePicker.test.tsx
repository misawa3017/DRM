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
      children: [{ id: 'f2', name: 'Q1', parentId: 'f1', createdBy: 'u', createdAt: '', canManage: false, canEdit: false }],
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null, canManage: false, canEdit: false }],
      canManage: false,
      canEdit: false,
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
      canManage: false,
      canEdit: false,
    });

    const { onSelect } = renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    expect(onSelect).toHaveBeenCalledWith({
      resourceType: 'folder',
      resourceId: 'f1',
      name: 'Finance',
      path: 'Root',
    });
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
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null, canManage: false, canEdit: false }],
      canManage: false,
      canEdit: false,
    });

    const { onSelect } = renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    fireEvent.click(screen.getByText('report.pdf'));

    expect(onSelect).toHaveBeenCalledWith({
      resourceType: 'document',
      resourceId: 'd1',
      name: 'report.pdf',
      path: 'Root / Finance',
    });
  });

  it('resets back to root folders each time the dialog is reopened', async () => {
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
      canManage: false,
      canEdit: false,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSelect = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={onSelect} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));
    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());

    // Simulate the dialog closing and reopening (as GrantPermissionForm does
    // via its pickerOpen state toggling) without the component unmounting —
    // it previously stayed stuck showing whatever folder was last browsed.
    rerender(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={false} onOpenChange={vi.fn()} onSelect={onSelect} />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={onSelect} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.queryByTestId('pick-current-folder')).not.toBeInTheDocument();
  });

  it('lets the user navigate back up to the parent folder via 返回上一層', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockImplementation(async (id: string) => {
      if (id === 'f1') {
        return {
          id: 'f1',
          name: 'Finance',
          parentId: null,
          createdBy: 'u',
          createdAt: '',
          children: [{ id: 'f2', name: 'Q1', parentId: 'f1', createdBy: 'u', createdAt: '', canManage: false, canEdit: false }],
          documents: [],
          canManage: false,
          canEdit: false,
        };
      }
      if (id === 'f2') {
        return {
          id: 'f2',
          name: 'Q1',
          parentId: 'f1',
          createdBy: 'u',
          createdAt: '',
          children: [],
          documents: [],
          canManage: false,
          canEdit: false,
        };
      }
      throw new Error(`unexpected id ${id}`);
    });

    renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByText('Q1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Q1'));

    await waitFor(() => expect(screen.getByText(/選擇這個資料夾：Root \/ Finance \/ Q1/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('resource-picker-up'));

    await waitFor(() => expect(screen.getByText(/選擇這個資料夾：Root \/ Finance/)).toBeInTheDocument());
  });

  it('reports the full ancestor path (not just the leaf name) when picking a nested folder', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockImplementation(async (id: string) => {
      if (id === 'f1') {
        return {
          id: 'f1',
          name: 'Finance',
          parentId: null,
          createdBy: 'u',
          createdAt: '',
          children: [{ id: 'f2', name: 'Q1', parentId: 'f1', createdBy: 'u', createdAt: '', canManage: false, canEdit: false }],
          documents: [],
          canManage: false,
          canEdit: false,
        };
      }
      if (id === 'f2') {
        return {
          id: 'f2',
          name: 'Q1',
          parentId: 'f1',
          createdBy: 'u',
          createdAt: '',
          children: [],
          documents: [],
          canManage: false,
          canEdit: false,
        };
      }
      throw new Error(`unexpected id ${id}`);
    });

    const { onSelect } = renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByText('Q1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Q1'));

    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    expect(onSelect).toHaveBeenCalledWith({
      resourceType: 'folder',
      resourceId: 'f2',
      name: 'Q1',
      path: 'Root / Finance',
    });
  });

  it('mode="folder-only" hides documents and does not let them be selected', async () => {
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
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null, canManage: true, canEdit: true }],
      canManage: true,
      canEdit: true,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSelect = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={onSelect} mode="folder-only" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument();
  });

  it('renders a custom title when provided', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={vi.fn()} title="選擇移動目的地" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('選擇移動目的地')).toBeInTheDocument());
  });

  it('renders errorMessage inside the dialog when provided', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker
          open={true}
          onOpenChange={vi.fn()}
          onSelect={vi.fn()}
          errorMessage="測試錯誤"
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('resource-picker-error')).toBeInTheDocument());
    expect(screen.getByTestId('resource-picker-error')).toHaveTextContent('測試錯誤');
  });
});
