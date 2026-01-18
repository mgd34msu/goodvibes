// ============================================================================
// ERROR FALLBACK COMPONENT
// ============================================================================

import type { FallbackProps } from 'react-error-boundary';

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-center min-h-screen bg-surface-950 p-8">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-error-500/20 flex items-center justify-center">
          <svg className="w-8 h-8 text-error-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-surface-100 mb-2">
          Something went wrong
        </h1>

        <p className="text-surface-400 mb-4">
          An unexpected error occurred. You can try reloading the application.
        </p>

        <div className="bg-surface-900 rounded-lg p-4 mb-6 text-left overflow-auto max-h-48">
          <code className="text-xs text-error-400 font-mono whitespace-pre-wrap">
            {error.message}
          </code>
        </div>

        <div className="flex gap-4 justify-center">
          <button
            onClick={resetErrorBoundary}
            className="btn btn-primary"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="btn btn-secondary"
          >
            Reload app
          </button>
        </div>
      </div>
    </div>
  );
}
