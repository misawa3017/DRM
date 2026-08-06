import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { CreateFolderDialog } from '../../src/components/CreateFolderDialog';
import { createFolder } from '../../src/api/folders';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({ createFolder: vi.fn() }));

describe('CreateFolderDialog', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('submits the entered name and parentId to createFolder', async () => {
    vi.mocked(createFolder).mockResolvedValue({
      id: 'new-folder',
      name: 'Docs',
      parentId: 'parent-1',
      createdBy: 'u',
      createdAt: '',
    });

    renderWithProviders(<CreateFolderDialog parentId="parent-1" />);

    fireEvent.click(screen.getByRole('button', { name: '新增資料夾' }));
    fireEvent.change(screen.getByTestId('folder-name-input'), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByTestId('submit-create-folder'));

    await waitFor(() =>
      expect(createFolder).toHaveBeenCalledWith(
        { name: 'Docs', parentId: 'parent-1' },
        'fake-token',
      ),
    );
  });
});
