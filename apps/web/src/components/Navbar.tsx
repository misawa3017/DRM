import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { Folder, Search } from 'lucide-react';
import { NavbarBreadcrumbContext } from '../lib/navbarBreadcrumb';
import { ThemeToggle } from './ThemeToggle';

interface WhoAmI {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
}

export function Navbar() {
  const auth = useAuth();
  const navigate = useNavigate();
  const accessToken = auth.user?.access_token ?? '';
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [crumb, setCrumb] = useState<ReactNode>(null);
  const [searchInput, setSearchInput] = useState('');

  const submitSearch = () => {
    const trimmed = searchInput.trim();
    if (!trimmed) return;
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  useEffect(() => {
    if (!accessToken) return;
    fetch(`${import.meta.env.VITE_API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(setWhoami)
      .catch(() => setWhoami(null));
  }, [accessToken]);

  const contextValue = useMemo(() => ({ crumb, setCrumb }), [crumb, setCrumb]);

  return (
    <NavbarBreadcrumbContext.Provider value={contextValue}>
      <header className="flex flex-wrap items-center gap-3 bg-primary px-4 py-3 text-primary-foreground sm:px-6 lg:flex-nowrap lg:gap-4">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 text-base font-semibold"
          data-testid="navbar-brand"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-foreground text-primary">
            <Folder className="h-4 w-4" />
          </span>
          DRM
        </Link>
        <nav className="order-2 flex shrink-0 gap-3 text-sm sm:gap-4 lg:order-none">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              isActive ? 'font-semibold text-white' : 'text-primary-foreground/75'
            }
          >
            資料夾
          </NavLink>
          <NavLink
            to="/permissions"
            className={({ isActive }) =>
              isActive ? 'font-semibold text-white' : 'text-primary-foreground/75'
            }
          >
            權限管理
          </NavLink>
        </nav>

        <div className="order-4 flex w-full items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2.5 py-2 sm:order-5 lg:order-none lg:w-56 lg:shrink-0 lg:py-1.5">
          <button
            type="button"
            aria-label="搜尋"
            onClick={submitSearch}
            className="text-primary-foreground/70 hover:text-primary-foreground"
          >
            <Search className="h-4 w-4" />
          </button>
          <input
            data-testid="navbar-search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch();
            }}
            placeholder="搜尋資料夾或文件..."
            className="w-full border-none bg-transparent text-sm text-primary-foreground placeholder:text-primary-foreground/50 focus:outline-none"
          />
        </div>

        <div
          className="order-5 hidden min-w-0 w-full items-center justify-start gap-1 overflow-hidden text-sm sm:flex lg:order-none lg:w-auto lg:flex-1 lg:justify-center"
          data-testid="navbar-crumb"
        >
          {crumb}
        </div>

        <div className="order-3 ml-auto flex shrink-0 items-center gap-2 text-sm lg:order-none lg:gap-3">
          <ThemeToggle />
          {whoami && (
            <>
              <span
                className="hidden rounded-full bg-primary-foreground/15 px-2.5 py-0.5 text-xs xl:inline"
                data-testid="navbar-roles"
              >
                {whoami.roles.join(', ')}
              </span>
              <span className="hidden lg:inline" data-testid="navbar-username">{whoami.displayName}</span>
            </>
          )}
          <button
            onClick={() => auth.signoutRedirect()}
            className="rounded-md bg-primary-foreground px-3 py-1.5 text-xs font-semibold text-primary"
            data-testid="navbar-logout"
          >
            登出
          </button>
        </div>
      </header>
      <Outlet />
    </NavbarBreadcrumbContext.Provider>
  );
}
