import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App';

// This only asserts that MaintenanceNotice is actually wired into the real
// App.tsx (not just tested in isolation, see MaintenanceNotice.test.tsx) --
// if someone accidentally removed <MaintenanceNotice /> from App.tsx, this
// test would fail where the isolated component test would not.
vi.mock('react-oidc-context', () => ({
  useAuth: vi.fn(),
}));

describe('App', () => {
  it('renders the maintenance banner alongside the logged-out login button', () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoading: false,
      error: undefined,
      isAuthenticated: false,
      signinRedirect: vi.fn(),
      signoutRedirect: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(<App />);

    expect(screen.getByText(/03:00/)).toBeInTheDocument();
    expect(screen.getByText(/例行維護/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it('renders the Navbar and RootFolders route once authenticated', async () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoading: false,
      error: undefined,
      isAuthenticated: true,
      user: { access_token: 'fake-token' },
      signinRedirect: vi.fn(),
      signoutRedirect: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes('/whoami')
            ? ({ ok: false, status: 401 } as Response)
            : ({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: async () => [],
              } as Response),
        ),
      ),
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('navbar-brand')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '資料夾' })).toBeInTheDocument();
  });
});
