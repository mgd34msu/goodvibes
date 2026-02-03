// ============================================================================
// REACT APPLICATION ENTRY POINT
// ============================================================================

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';

import App from './App';
import { ErrorFallback } from './components/common/ErrorFallback';
import { createLogger } from '../shared/logger';
import './styles/index.css';

const logger = createLogger('Main');

// Create React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Global error handler
function handleError(error: unknown, info: React.ErrorInfo) {
  logger.error('Application Error:', error);
  logger.error('Error Info:', info);
}

// Render application
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found. Make sure there is a <div id="root"></div> in your HTML.');
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <ErrorBoundary FallbackComponent={ErrorFallback} onError={handleError}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
