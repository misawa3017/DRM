import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MaintenanceNotice } from '../src/MaintenanceNotice';

describe('MaintenanceNotice', () => {
  it('renders the fixed daily maintenance window message', () => {
    render(<MaintenanceNotice />);
    expect(screen.getByText(/03:00/)).toBeInTheDocument();
    expect(screen.getByText(/例行維護/)).toBeInTheDocument();
  });
});
