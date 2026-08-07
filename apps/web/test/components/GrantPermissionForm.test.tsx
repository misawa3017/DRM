import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { GrantPermissionForm } from '../../src/components/GrantPermissionForm';
import { searchUsers } from '../../src/api/users';
import { grantPermission } from '../../src/api/permissions';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({ grantPermission: vi.fn() }));

function renderForm(props: Parameters<typeof GrantPermissionForm>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GrantPermissionForm {...props} />
    </QueryClientProvider>,
  );
}

describe('GrantPermissionForm', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('with a fixedResource, searches users, selects one, and grants the chosen level', async () => {
    vi.mocked(searchUsers).mockResolvedValue([
      { id: 'u1', email: 'alice@example.com', displayName: 'Alice', department: null },
    ]);
    vi.mocked(grantPermission).mockResolvedValue({
      id: 'p1',
      resourceType: 'folder',
      resourceId: 'f1',
      principalType: 'user',
      principalId: 'u1',
      permissionLevel: 'edit',
      grantedBy: 'admin',
      grantedAt: '',
      principal: null,
    });
    const onGranted = vi.fn();

    renderForm({
      fixedResource: { resourceType: 'folder', resourceId: 'f1' },
      onGranted,
    });

    fireEvent.change(screen.getByTestId('user-search-input'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('user-search-submit'));

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Alice'));

    fireEvent.change(screen.getByTestId('permission-level-select'), { target: { value: 'edit' } });
    fireEvent.click(screen.getByTestId('grant-submit'));

    await waitFor(() =>
      expect(grantPermission).toHaveBeenCalledWith(
        'folder',
        'f1',
        { principalId: 'u1', permissionLevel: 'edit' },
        'fake-token',
      ),
    );
    await waitFor(() => expect(onGranted).toHaveBeenCalled());
  });

  it('shows a message when the search returns no results', async () => {
    vi.mocked(searchUsers).mockResolvedValue([]);

    renderForm({ fixedResource: { resourceType: 'folder', resourceId: 'f1' }, onGranted: vi.fn() });

    fireEvent.change(screen.getByTestId('user-search-input'), { target: { value: 'nobody' } });
    fireEvent.click(screen.getByTestId('user-search-submit'));

    await waitFor(() => expect(screen.getByTestId('no-results')).toBeInTheDocument());
  });

  it('without a fixedResource, the grant button stays disabled until a resource is picked', async () => {
    renderForm({ onGranted: vi.fn() });

    expect(screen.getByTestId('grant-submit')).toBeDisabled();
    expect(screen.getByTestId('open-resource-picker')).toBeInTheDocument();
  });

  it('shows a friendly error message when the user search fails', async () => {
    vi.mocked(searchUsers).mockRejectedValue(new Error('network down'));

    renderForm({ fixedResource: { resourceType: 'folder', resourceId: 'f1' }, onGranted: vi.fn() });

    fireEvent.change(screen.getByTestId('user-search-input'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('user-search-submit'));

    await waitFor(() => expect(screen.getByText('發生錯誤，請稍後再試')).toBeInTheDocument());
  });

  it('shows a friendly error message when granting the permission fails', async () => {
    vi.mocked(searchUsers).mockResolvedValue([
      { id: 'u1', email: 'alice@example.com', displayName: 'Alice', department: null },
    ]);
    vi.mocked(grantPermission).mockRejectedValue(new Error('server exploded'));

    renderForm({ fixedResource: { resourceType: 'folder', resourceId: 'f1' }, onGranted: vi.fn() });

    fireEvent.change(screen.getByTestId('user-search-input'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('user-search-submit'));

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Alice'));

    fireEvent.click(screen.getByTestId('grant-submit'));

    await waitFor(() => expect(screen.getByText('發生錯誤，請稍後再試')).toBeInTheDocument());
  });
});
