import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('drm-theme', next ? 'dark' : 'light');
    setDark(next);
  };

  return (
    <button
      type="button"
      aria-label={dark ? '切換為淺色模式' : '切換為深色模式'}
      title={dark ? '切換為淺色模式' : '切換為深色模式'}
      data-testid="theme-toggle"
      onClick={toggleTheme}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
