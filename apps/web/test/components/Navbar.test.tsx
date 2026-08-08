import { useMemo, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { Navbar } from '../../src/components/Navbar';
import { useSetNavbarCrumb } from '../../src/lib/navbarBreadcrumb';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));

function SearchProbe() {
  const [params] = useSearchParams();
  return <div>search results page: {params.get('q')}</div>;
}

function renderNavbar(child: ReactNode = <div>page content</div>) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={child} />
          <Route path="/search" element={<SearchProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Mirrors how FolderView really consumes the hook: the crumb element is memoized, so its
 * identity is stable across renders. Handing the hook a freshly constructed element on every
 * render instead re-fires its effect forever — the unbounded re-render loop this guards against.
 */
function CrumbSettingChild({ onRender }: { onRender?: () => void }) {
  onRender?.();
  const crumb = useMemo(() => <span>Test Crumb</span>, []);
  useSetNavbarCrumb(crumb);

  return <div>child content</div>;
}

describe('Navbar', () => {
  const signoutRedirect = vi.fn();

  beforeEach(() => {
    signoutRedirect.mockClear();
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
      signoutRedirect,
    } as unknown as ReturnType<typeof useAuth>);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: '1',
          email: 'admin@example.com',
          displayName: 'Test Admin',
          roles: ['admin'],
        }),
      } as Response),
    );
  });

  it('renders the brand mark, user info from /whoami, and routed page content', async () => {
    renderNavbar();

    expect(screen.getByTestId('navbar-brand')).toHaveTextContent('DRM');
    expect(screen.getByText('page content')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId('navbar-username')).toHaveTextContent('Test Admin'),
    );
    expect(screen.getByTestId('navbar-roles')).toHaveTextContent('admin');
  });

  it('renders a crumb set by a child route inside the navbar-crumb slot', async () => {
    renderNavbar(<CrumbSettingChild />);

    expect(screen.getByText('child content')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('navbar-crumb')).toHaveTextContent('Test Crumb'));
  });

  it('settles instead of re-rendering the crumb-setting route in a loop', async () => {
    const onRender = vi.fn();
    renderNavbar(<CrumbSettingChild onRender={onRender} />);

    await waitFor(() => expect(screen.getByTestId('navbar-crumb')).toHaveTextContent('Test Crumb'));

    const rendersAfterSettle = onRender.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onRender.mock.calls.length).toBe(rendersAfterSettle);
    expect(rendersAfterSettle).toBeLessThanOrEqual(10);
  });

  it('calls signoutRedirect when the logout button is clicked', async () => {
    renderNavbar();

    fireEvent.click(screen.getByTestId('navbar-logout'));

    expect(signoutRedirect).toHaveBeenCalledTimes(1);
  });

  it('renders 資料夾 and 權限管理 nav tabs linking to / and /permissions', async () => {
    renderNavbar();

    const foldersLink = screen.getByRole('link', { name: '資料夾' });
    const permissionsLink = screen.getByRole('link', { name: '權限管理' });
    expect(foldersLink).toHaveAttribute('href', '/');
    expect(permissionsLink).toHaveAttribute('href', '/permissions');
  });

  it('navigates to /search?q=... when a search term is submitted via Enter', async () => {
    renderNavbar();

    const input = screen.getByTestId('navbar-search-input');
    fireEvent.change(input, { target: { value: 'finance report' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByText('search results page: finance report')).toBeInTheDocument(),
    );
  });

  it('does not navigate when the search input is blank', async () => {
    renderNavbar();

    const input = screen.getByTestId('navbar-search-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.queryByText(/search results page/)).not.toBeInTheDocument();
  });
});
