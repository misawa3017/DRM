import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from '../../src/components/ThemeToggle';

describe('ThemeToggle', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.removeItem('drm-theme');
  });

  it('切換深色模式並保存偏好', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByTestId('theme-toggle'));

    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('drm-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: '切換為淺色模式' })).toBeInTheDocument();
  });

  it('可從既有深色模式切回淺色', () => {
    document.documentElement.classList.add('dark');
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button', { name: '切換為淺色模式' }));

    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('drm-theme')).toBe('light');
  });
});
