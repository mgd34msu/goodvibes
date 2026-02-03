// ============================================================================
// TERMINAL ERROR FALLBACK - Shows when a terminal component crashes
// Provides a meaningful error UI that allows recovery without affecting other terminals
// ============================================================================

import React from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('TerminalErrorFallback');

// ============================================================================
// TYPES
// ============================================================================

export interface TerminalErrorFallbackProps {
  /** The error that caused the crash */
  error: Error;
  /** ID of the crashed terminal */
  terminalId: number;
  /** Name of the crashed terminal for display */
  terminalName: string;
  /** Callback to attempt recovery by resetting the error boundary */
  onRetry: () => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TerminalErrorFallback({
  error,
  terminalId,
  terminalName,
  onRetry,
}: TerminalErrorFallbackProps): React.JSX.Element {
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);

  // Log the error for debugging
  React.useEffect(() => {
    logger.error('Terminal crashed', {
      terminalId,
      terminalName,
      errorMessage: error.message,
      errorStack: error.stack,
    });
  }, [error, terminalId, terminalName]);

  const handleClose = (): void => {
    closeTerminal(terminalId);
  };

  // Check if we're in development mode for showing detailed error info
  const isDevelopment = process.env.NODE_ENV !== 'production';

  return (
    <div
      className="flex flex-col items-center justify-center h-full w-full p-8 text-center bg-surface-900"
      role="alert"
      aria-live="assertive"
    >
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
        Terminal Error
      </h2>

      {/* Terminal Name */}
      <p className="text-surface-400 mb-2">
        The terminal "{terminalName}" encountered an error and stopped working.
      </p>

      {/* User-friendly message */}
      <p className="text-surface-500 text-sm mb-6 max-w-md">
        {isDevelopment
          ? 'Check the error details below for debugging information.'
          : 'You can try to recover the terminal or close it to continue working.'}
      </p>

      {/* Development mode: Show error details */}
      {isDevelopment && (
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
              <pre className="mt-2 p-4 bg-surface-800 rounded-lg text-xs text-surface-300 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {error.stack}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center gap-4">
        <button
          onClick={onRetry}
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

        <button
          onClick={handleClose}
          className="btn btn-secondary flex items-center gap-2"
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
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
          Close Terminal
        </button>
      </div>

      {/* Additional Info */}
      <p className="mt-6 text-xs text-surface-600">
        Other terminals are unaffected and continue to work normally.
      </p>
    </div>
  );
}

export default TerminalErrorFallback;
