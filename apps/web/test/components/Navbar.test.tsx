import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { Navbar } from '../../src/components/Navbar';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));

function renderNavbar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={<div>page content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
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

  it('calls signoutRedirect when the logout button is clicked', async () => {
    renderNavbar();

    fireEvent.click(screen.getByTestId('navbar-logout'));

    expect(signoutRedirect).toHaveBeenCalledTimes(1);
  });
});
