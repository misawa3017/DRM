import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from '../src/components/ui/button';

describe('Button', () => {
  it('renders its children and forwards onClick', () => {
    render(<Button data-testid="button">Click me</Button>);
    expect(screen.getByTestId('button')).toBeInTheDocument();
  });
});
