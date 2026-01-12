// ============================================================================
// ERROR BOUNDARY COMPONENT
// ============================================================================

import React, { Component, ErrorInfo } from 'react';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('ErrorBoundary');

interface ErrorBoundaryProps {
  /** Fallback UI to show on error */
  fallback?: React.ReactNode;
  /** Custom fallback render function */
  fallbackRender?: (props: FallbackRenderProps) => React.ReactNode;
  /** Callback when error occurs */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Callback when reset is triggered */
  onReset?: () => void;
  /** Reset keys - when these change, the error boundary resets */
  resetKeys?: unknown[];
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export interface FallbackRenderProps {
  error: Error;
  resetErrorBoundary: () => void;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error('ErrorBoundary caught an error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    const { resetKeys } = this.props;
    const { hasError } = this.state;

    if (hasError && prevProps.resetKeys !== resetKeys) {
      // Check if any reset key changed
      if (
        resetKeys?.some(
          (key, index) => prevProps.resetKeys?.[index] !== key
        )
      ) {
        this.resetErrorBoundary();
      }
    }
  }

  resetErrorBoundary = (): void => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  override render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { fallback, fallbackRender, children } = this.props;

    if (hasError && error) {
      if (fallbackRender) {
        return fallbackRender({ error, resetErrorBoundary: this.resetErrorBoundary });
      }

      if (fallback) {
        return fallback;
      }

      return <DefaultErrorFallback error={error} resetErrorBoundary={this.resetErrorBoundary} />;
    }

    return children;
  }
}

// ============================================================================
// DEFAULT ERROR FALLBACK
// ============================================================================

function DefaultErrorFallback({ error, resetErrorBoundary }: FallbackRenderProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center min-h-[200px] p-8 text-center"
    >
      <div className="text-error-500 mb-4">
        <svg
          className="w-16 h-16 mx-auto"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>

      <h2 className="text-xl font-semibold text-surface-100 mb-2">Something went wrong</h2>

      <p className="text-surface-400 mb-4 max-w-md">
        An unexpected error occurred. This has been logged for investigation.
      </p>

      <details className="mb-4 text-left max-w-lg">
        <summary className="cursor-pointer text-surface-500 hover:text-surface-300">
          Technical details
        </summary>
        <pre className="mt-2 p-4 bg-surface-900 rounded-lg text-xs text-error-400 overflow-auto max-h-32">
          {error.message}
          {error.stack && `\n\n${error.stack}`}
        </pre>
      </details>

      <button
        onClick={resetErrorBoundary}
        className="btn btn-primary"
      >
        Try again
      </button>
    </div>
  );
}

// ============================================================================
// HOOK FOR RESETTING ERROR BOUNDARIES
// ============================================================================

export function useErrorHandler(): (error: Error) => void {
  const [, setError] = React.useState<Error | null>(null);

  return React.useCallback((error: Error) => {
    setError(() => {
      throw error;
    });
  }, []);
}
