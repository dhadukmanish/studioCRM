import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';
import { useUiStore } from './store/ui';
import { applyTheme } from './lib/theme';

// Apply the saved theme before first paint and follow OS changes when on 'system'.
applyTheme(useUiStore.getState().theme);
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (useUiStore.getState().theme === 'system') applyTheme('system'); });

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
