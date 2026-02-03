// ============================================================================
// ERROR BOUNDARY COMPONENT
// Catches JavaScript errors in child components and displays user-friendly UI
// ============================================================================

import React, { Component, type ErrorInfo } from 'react';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('ErrorBoundary');

// Check if we're in development mode for showing detailed error info
const isDevelopment = process.env.NODE_ENV !== 'production';

// ============================================================================
// Types
// ============================================================================

export interface ErrorBoundaryProps {
  /** Fallback UI to show on error */
  fallback?: React.ReactNode;
  /** Custom fallback render function for dynamic error handling */
  fallbackRender?: (props: FallbackRenderProps) => React.ReactNode;
  /** Callback when error occurs - useful for error reporting */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Callback when reset is triggered */
  onReset?: () => void;
  /** Reset keys - when these change, the error boundary resets automatically */
  resetKeys?: unknown[];
  /** Whether to show full-page error UI (default: false) */
  fullPage?: boolean;
  /** Children to render when no error */
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export interface FallbackRenderProps {
  /** The error that was caught */
  error: Error;
  /** Additional error info including component stack */
  errorInfo: ErrorInfo | null;
  /** Function to reset the error boundary and try again */
  resetErrorBoundary: () => void;
  /** Whether we're in development mode */
  isDevelopment: boolean;
}

// ============================================================================
// ErrorBoundary Component
// ============================================================================

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Update state to trigger fallback UI
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error details for debugging
    logger.error('ErrorBoundary caught an error:', error);
    if (isDevelopment) {
      logger.error('Component stack:', errorInfo.componentStack);
    }

    // Store errorInfo for detailed display
    this.setState({ errorInfo });

    // Call optional error callback for external error reporting
    this.props.onError?.(error, errorInfo);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    const { resetKeys } = this.props;
    const { hasError } = this.state;

    // Reset error state when resetKeys change
    if (hasError && resetKeys !== undefined && prevProps.resetKeys !== undefined) {
      const keysChanged = resetKeys.some(
        (key: unknown, index: number) => prevProps.resetKeys?.[index] !== key
      );
      if (keysChanged) {
        this.resetErrorBoundary();
      }
    }
  }

  resetErrorBoundary = (): void => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  override render(): React.ReactNode {
    const { hasError, error, errorInfo } = this.state;
    const { fallback, fallbackRender, children, fullPage } = this.props;

    if (hasError && error) {
      // Use custom fallback render if provided
      if (fallbackRender) {
        return fallbackRender({
          error,
          errorInfo,
          resetErrorBoundary: this.resetErrorBoundary,
          isDevelopment,
        });
      }

      // Use static fallback if provided
      if (fallback) {
        return fallback;
      }

      // Use default error UI
      return (
        <DefaultErrorFallback
          error={error}
          errorInfo={errorInfo}
          resetErrorBoundary={this.resetErrorBoundary}
          isDevelopment={isDevelopment}
          fullPage={fullPage}
        />
      );
    }

    return children;
  }
}

// ============================================================================
// DEFAULT ERROR FALLBACK
// Shows user-friendly error message with dev/prod mode awareness
// ============================================================================

interface DefaultErrorFallbackProps extends FallbackRenderProps {
  fullPage?: boolean;
}

function DefaultErrorFallback({
  error,
  errorInfo,
  resetErrorBoundary,
  isDevelopment: isDevMode,
  fullPage = false,
}: DefaultErrorFallbackProps): React.JSX.Element {
  // Determine container styles based on fullPage prop
  const containerClasses = fullPage
    ? 'flex flex-col items-center justify-center min-h-screen p-8 text-center bg-surface-950'
    : 'flex flex-col items-center justify-center min-h-[300px] p-8 text-center';

  return (
    <div role="alert" aria-live="assertive" className={containerClasses}>
      {/* Error Icon */}
      <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-error-500/20 flex items-center justify-center">
        <svg
          className="w-8 h-8 text-error-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>

      {/* Error Title */}
      <h2 className="text-xl font-semibold text-surface-100 mb-2">
        Something went wrong
      </h2>

      {/* User-friendly message */}
      <p className="text-surface-400 mb-6 max-w-md">
        {isDevMode
          ? 'An error occurred while rendering this component. Check the details below for debugging information.'
          : 'An unexpected error occurred. Please try again or contact support if the problem persists.'}
      </p>

      {/* Development mode: Show full error details */}
      {isDevMode && (
        <div className="mb-6 text-left max-w-2xl w-full">
          {/* Error Message */}
          <div className="mb-4 p-4 bg-error-500/10 border border-error-500/30 rounded-lg">
            <h3 className="text-sm font-medium text-error-400 mb-2">Error Message</h3>
            <code className="text-sm text-error-300 font-mono break-all">
              {error.message}
            </code>
          </div>

          {/* Stack Trace (collapsible) */}
          {error.stack && (
            <details className="mb-4">
              <summary className="cursor-pointer text-sm text-surface-400 hover:text-surface-200 font-medium">
                Stack Trace
              </summary>
              <pre className="mt-2 p-4 bg-surface-900 rounded-lg text-xs text-surface-300 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {error.stack}
              </pre>
            </details>
          )}

          {/* Component Stack (collapsible) */}
          {errorInfo?.componentStack && (
            <details>
              <summary className="cursor-pointer text-sm text-surface-400 hover:text-surface-200 font-medium">
                Component Stack
              </summary>
              <pre className="mt-2 p-4 bg-surface-900 rounded-lg text-xs text-surface-300 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Production mode: Simple error ID for support */}
      {!isDevMode && (
        <div className="mb-6 p-4 bg-surface-900 rounded-lg max-w-md">
          <p className="text-sm text-surface-500">
            Error ID: {generateErrorId(error)}
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center gap-4">
        <button
          onClick={resetErrorBoundary}
          className="btn btn-primary flex items-center gap-2"
          type="button"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Try Again
        </button>

        {fullPage && (
          <button
            onClick={() => window.location.reload()}
            className="btn btn-secondary"
            type="button"
          >
            Reload App
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Generate a short error ID for production error tracking
 * This helps users report issues without exposing sensitive stack traces
 */
function generateErrorId(error: Error): string {
  const hash = error.message.split('').reduce((acc: number, char: string) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);
  return `ERR-${Math.abs(hash).toString(36).toUpperCase().slice(0, 8)}`;
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
