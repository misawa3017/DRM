import { screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { renderWithProviders } from './testUtils';

function Probe() {
  const query = useQuery({ queryKey: ['probe'], queryFn: async () => 'ok' });
  return (
    <div>
      <Link to="/somewhere" data-testid="link">
        go
      </Link>
      <span data-testid="query-status">{query.status}</span>
    </div>
  );
}

describe('renderWithProviders', () => {
  it('provides both router and query client context to children', async () => {
    renderWithProviders(<Probe />);
    expect(screen.getByTestId('link')).toBeInTheDocument();
    expect(screen.getByTestId('query-status')).toBeInTheDocument();
  });
});
