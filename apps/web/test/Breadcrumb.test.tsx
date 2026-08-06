import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { Breadcrumb } from '../src/components/Breadcrumb';
import { getFolder } from '../src/api/folders';
import { renderWithProviders } from './testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../src/api/folders', () => ({ getFolder: vi.fn() }));

describe('Breadcrumb', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('walks the parent chain and renders ancestors in root-to-leaf order', async () => {
    vi.mocked(getFolder).mockImplementation(async (id: string) => {
      if (id === 'folder-b') {
        return {
          id: 'folder-b',
          name: 'B',
          parentId: 'folder-a',
          createdBy: 'u',
          createdAt: '',
          children: [],
          documents: [],
        };
      }
      if (id === 'folder-a') {
        return {
          id: 'folder-a',
          name: 'A',
          parentId: null,
          createdBy: 'u',
          createdAt: '',
          children: [],
          documents: [],
        };
      }
      throw new Error(`unexpected id ${id}`);
    });

    renderWithProviders(<Breadcrumb currentId="folder-c" currentName="C" parentId="folder-b" />);

    await waitFor(() => expect(screen.getByText('C')).toBeInTheDocument());
    const links = screen.getAllByRole('link').map((el) => el.textContent);
    expect(links).toEqual(['Root', 'A', 'B']);
  });
});
