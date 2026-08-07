import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from 'react-oidc-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { oidcConfig } from './auth/authConfig';
import { shouldRetryQuery } from './lib/queryRetry';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: shouldRetryQuery },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider {...oidcConfig}>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
