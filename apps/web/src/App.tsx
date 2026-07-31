import { useAuth } from 'react-oidc-context';
import { Home } from './Home';

export default function App() {
  const auth = useAuth();

  if (auth.isLoading) return <p>Loading...</p>;
  if (auth.error) return <p>Auth error: {auth.error.message}</p>;

  if (!auth.isAuthenticated) {
    return <button onClick={() => auth.signinRedirect()}>Log in</button>;
  }

  return (
    <div>
      <button onClick={() => auth.signoutRedirect()}>Log out</button>
      <Home accessToken={auth.user?.access_token ?? ''} />
    </div>
  );
}
