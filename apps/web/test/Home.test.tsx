import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Home } from '../src/Home';

describe('Home', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders the whoami response once loaded', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '1',
        email: 'testuser@example.com',
        displayName: 'Test User',
        roles: ['employee'],
      }),
    } as Response);

    render(<Home accessToken="fake-token" />);

    await waitFor(() => screen.getByTestId('whoami'));
    expect(screen.getByText('Email: testuser@example.com')).toBeInTheDocument();
  });

  it('renders an error when the request fails', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);

    render(<Home accessToken="fake-token" />);

    await waitFor(() => screen.getByTestId('error'));
  });
});
