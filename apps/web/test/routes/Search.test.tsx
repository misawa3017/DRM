import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { Search } from '../../src/routes/Search';
import { searchResources } from '../../src/api/search';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/search', () => ({ searchResources: vi.fn() }));

describe('Search', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('shows a prompt and does not call the API when there is no query', async () => {
    renderWithProviders(<Search />, { route: '/search', path: '/search' });

    expect(screen.getByText('請輸入關鍵字搜尋')).toBeInTheDocument();
    expect(searchResources).not.toHaveBeenCalled();
  });

  it('calls searchResources with the URL query and shows results', async () => {
    vi.mocked(searchResources).mockResolvedValue([
      { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
      {
        resourceType: 'document',
        resourceId: 'd1',
        name: 'report.pdf',
        path: 'Root / Finance',
      },
    ]);

    renderWithProviders(<Search />, { route: '/search?q=finance', path: '/search' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.getByText('Root')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('Root / Finance')).toBeInTheDocument();
    expect(searchResources).toHaveBeenCalledWith('finance', 'fake-token');
  });

  it('shows a not-found message when the query returns no results', async () => {
    vi.mocked(searchResources).mockResolvedValue([]);

    renderWithProviders(<Search />, { route: '/search?q=nothing', path: '/search' });

    await waitFor(() => expect(screen.getByText('找不到符合的項目')).toBeInTheDocument());
  });

  it('links a folder result to /folders/:id and a document result to /documents/:id', async () => {
    vi.mocked(searchResources).mockResolvedValue([
      { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
      {
        resourceType: 'document',
        resourceId: 'd1',
        name: 'report.pdf',
        path: 'Root / Finance',
      },
    ]);

    renderWithProviders(<Search />, { route: '/search?q=finance', path: '/search' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /^Finance/ })).toHaveAttribute(
      'href',
      '/folders/f1',
    );
    expect(screen.getByRole('link', { name: /report\.pdf/ })).toHaveAttribute(
      'href',
      '/documents/d1',
    );
  });
});
