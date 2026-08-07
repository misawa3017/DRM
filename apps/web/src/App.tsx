import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MaintenanceNotice } from './MaintenanceNotice';
import { Navbar } from './components/Navbar';
import { RootFolders } from './routes/RootFolders';
import { FolderView } from './routes/FolderView';
import { DocumentView } from './routes/DocumentView';
import { PermissionsDashboard } from './routes/PermissionsDashboard';
import { FolderPermissions } from './routes/FolderPermissions';
import { DocumentPermissions } from './routes/DocumentPermissions';

function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <>
      <MaintenanceNotice />
      <div className="flex min-h-[80vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Folder className="h-6 w-6" />
        </span>
        <span className="text-lg font-semibold">DRM</span>
        {children}
      </div>
    </>
  );
}

export default function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <AuthScreen>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </AuthScreen>
    );
  }
  if (auth.error) {
    return (
      <AuthScreen>
        <p className="text-sm text-destructive">Auth error: {auth.error.message}</p>
      </AuthScreen>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <AuthScreen>
        <Button onClick={() => auth.signinRedirect()}>Log in</Button>
      </AuthScreen>
    );
  }

  return (
    <BrowserRouter>
      <MaintenanceNotice />
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={<RootFolders />} />
          <Route path="/folders/:id" element={<FolderView />} />
          <Route path="/folders/:id/permissions" element={<FolderPermissions />} />
          <Route path="/documents/:id" element={<DocumentView />} />
          <Route path="/documents/:id/permissions" element={<DocumentPermissions />} />
          <Route path="/permissions" element={<PermissionsDashboard />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
