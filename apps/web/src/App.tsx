import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './Home';
import { MaintenanceNotice } from './MaintenanceNotice';
import { RootFolders } from './routes/RootFolders';

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
      <div>
        <button onClick={() => auth.signoutRedirect()}>Log out</button>
        <Home accessToken={auth.user?.access_token ?? ''} />
        <Routes>
          <Route path="/" element={<RootFolders />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
