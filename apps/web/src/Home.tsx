import { useEffect, useState } from 'react';

interface WhoAmI {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
}

export function Home({ accessToken }: { accessToken: string }) {
  const [data, setData] = useState<WhoAmI | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    fetch(`${import.meta.env.VITE_API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [accessToken]);

  if (error) return <p data-testid="error">{error}</p>;
  if (!data) return <p data-testid="loading">Loading profile...</p>;

  return (
    <div data-testid="whoami">
      <p>Email: {data.email}</p>
      <p>Name: {data.displayName}</p>
      <p>Roles: {data.roles.join(', ')}</p>
    </div>
  );
}
