import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAuth } from 'react-oidc-context';
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
});
