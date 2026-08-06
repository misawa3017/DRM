import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { MaintenanceNotice } from './MaintenanceNotice';
import { Navbar } from './components/Navbar';
import { RootFolders } from './routes/RootFolders';
import { FolderView } from './routes/FolderView';
import { DocumentView } from './routes/DocumentView';

export default function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <>
        <MaintenanceNotice />
        <p>Loading...</p>
      </>
    );
  }
  if (auth.error) {
    return (
      <>
        <MaintenanceNotice />
        <p>Auth error: {auth.error.message}</p>
      </>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <>
        <MaintenanceNotice />
        <button onClick={() => auth.signinRedirect()}>Log in</button>
      </>
    );
  }

  return (
    <BrowserRouter>
      <MaintenanceNotice />
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={<RootFolders />} />
          <Route path="/folders/:id" element={<FolderView />} />
          <Route path="/documents/:id" element={<DocumentView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
