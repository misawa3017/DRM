import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { Folder } from 'lucide-react';
import { NavbarBreadcrumbContext } from '../lib/navbarBreadcrumb';

interface WhoAmI {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
}

export function Navbar() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [crumb, setCrumb] = useState<ReactNode>(null);

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

  return (
    <NavbarBreadcrumbContext.Provider value={{ crumb, setCrumb }}>
      <header className="flex items-center justify-between gap-4 bg-primary px-6 py-3 text-primary-foreground">
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

        <div
          className="flex min-w-0 flex-1 items-center justify-center gap-1 text-sm"
          data-testid="navbar-crumb"
        >
          {crumb}
        </div>

        <div className="flex shrink-0 items-center gap-3 text-sm">
          {whoami && (
            <>
              <span
                className="rounded-full bg-primary-foreground/15 px-2.5 py-0.5 text-xs"
                data-testid="navbar-roles"
              >
                {whoami.roles.join(', ')}
              </span>
              <span data-testid="navbar-username">{whoami.displayName}</span>
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
