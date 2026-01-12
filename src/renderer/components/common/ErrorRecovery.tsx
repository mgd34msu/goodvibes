// ============================================================================
// ERROR RECOVERY COMPONENT
// Enhanced error boundary with retry, categorization, and recovery actions
// ============================================================================

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  RefreshCw,
  Wifi,
  WifiOff,
  Lock,
  Database,
  Bug,
  Home,
  ArrowLeft,
} from 'lucide-react';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('ErrorRecovery');

// ============================================================================
// Error Categories
// ============================================================================

export type ErrorCategory = 'network' | 'auth' | 'data' | 'runtime' | 'unknown';

export interface CategorizedError {
  category: ErrorCategory;
  originalError: Error;
  userMessage: string;
  technicalDetails: string;
  isRetryable: boolean;
  recoveryActions: RecoveryAction[];
}

export interface RecoveryAction {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  action: () => void | Promise<void>;
  isPrimary?: boolean;
}

// ============================================================================
// Error Categorization Logic
// ============================================================================

function categorizeError(error: Error): CategorizedError {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Network errors
  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('failed to fetch') ||
    message.includes('net::') ||
    message.includes('connection') ||
    message.includes('timeout') ||
    message.includes('offline') ||
    name.includes('networkerror') ||
    name.includes('aborterror')
  ) {
    return {
      category: 'network',
      originalError: error,
      userMessage: 'Unable to connect to the server. Please check your internet connection.',
      technicalDetails: error.message,
      isRetryable: true,
      recoveryActions: [],
    };
  }

  // Authentication errors
  if (
    message.includes('unauthorized') ||
    message.includes('authentication') ||
    message.includes('auth') ||
    message.includes('forbidden') ||
    message.includes('401') ||
    message.includes('403') ||
    message.includes('token') ||
    message.includes('session expired') ||
    message.includes('login')
  ) {
    return {
      category: 'auth',
      originalError: error,
      userMessage: 'Your session has expired or you don\'t have permission to access this resource.',
      technicalDetails: error.message,
      isRetryable: false,
      recoveryActions: [],
    };
  }

  // Data errors
  if (
    message.includes('data') ||
    message.includes('parse') ||
    message.includes('json') ||
    message.includes('database') ||
    message.includes('sqlite') ||
    message.includes('syntax') ||
    message.includes('malformed') ||
    message.includes('invalid') ||
    name.includes('syntaxerror') ||
    name.includes('typeerror')
  ) {
    return {
      category: 'data',
      originalError: error,
      userMessage: 'There was a problem processing the data. This may be a temporary issue.',
      technicalDetails: error.message,
      isRetryable: true,
      recoveryActions: [],
    };
  }

  // Runtime errors (React, JS errors)
  if (
    name.includes('error') ||
    message.includes('undefined') ||
    message.includes('null') ||
    message.includes('cannot read') ||
    message.includes('is not a function') ||
    message.includes('component')
  ) {
    return {
      category: 'runtime',
      originalError: error,
      userMessage: 'Something unexpected happened in the application.',
      technicalDetails: error.stack || error.message,
      isRetryable: true,
      recoveryActions: [],
    };
  }

  // Unknown errors
  return {
    category: 'unknown',
    originalError: error,
    userMessage: 'An unexpected error occurred.',
    technicalDetails: error.stack || error.message,
    isRetryable: true,
    recoveryActions: [],
  };
}

// ============================================================================
// Error Icons by Category
// ============================================================================

function ErrorIcon({ category, className }: { category: ErrorCategory; className?: string }) {
  const iconClass = clsx('w-12 h-12', className);

  switch (category) {
    case 'network':
      return <WifiOff className={iconClass} />;
    case 'auth':
      return <Lock className={iconClass} />;
    case 'data':
      return <Database className={iconClass} />;
    case 'runtime':
      return <Bug className={iconClass} />;
    default:
      return <AlertTriangle className={iconClass} />;
  }
}

// ============================================================================
// Component Props
// ============================================================================

export interface ErrorRecoveryProps {
  children: ReactNode;
  /** Custom error categorizer */
  categorizeError?: (error: Error) => CategorizedError;
  /** Callback when error occurs */
  onError?: (error: CategorizedError, errorInfo: ErrorInfo) => void;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Initial retry delay in ms */
  retryDelay?: number;
  /** Max retry delay in ms */
  maxRetryDelay?: number;
  /** Custom recovery actions by category */
  recoveryActions?: Partial<Record<ErrorCategory, RecoveryAction[]>>;
  /** Reset keys - when these change, the boundary resets */
  resetKeys?: unknown[];
  /** Callback when reset is triggered */
  onReset?: () => void;
  /** Whether to show technical details */
  showTechnicalDetails?: boolean;
  /** Custom error UI renderer */
  renderError?: (props: ErrorRenderProps) => ReactNode;
  /** Full-page error display */
  fullPage?: boolean;
}

export interface ErrorRenderProps {
  error: CategorizedError;
  retryCount: number;
  maxRetries: number;
  isRetrying: boolean;
  retryIn: number | null;
  onRetry: () => void;
  onReset: () => void;
  onGoHome?: () => void;
  onGoBack?: () => void;
}

interface ErrorRecoveryState {
  hasError: boolean;
  error: CategorizedError | null;
  retryCount: number;
  isRetrying: boolean;
  retryIn: number | null;
}

// ============================================================================
// Component
// ============================================================================

export class ErrorRecovery extends Component<ErrorRecoveryProps, ErrorRecoveryState> {
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private countdownIntervalId: ReturnType<typeof setInterval> | null = null;

  static defaultProps = {
    maxRetries: 3,
    retryDelay: 1000,
    maxRetryDelay: 30000,
    showTechnicalDetails: true,
    fullPage: false,
  };

  constructor(props: ErrorRecoveryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
      isRetrying: false,
      retryIn: null,
    };
  }

  static getDerivedStateFromError(_error: Error): Partial<ErrorRecoveryState> {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const categorizer = this.props.categorizeError || categorizeError;
    const categorizedError = categorizer(error);

    // Add custom recovery actions
    if (this.props.recoveryActions?.[categorizedError.category]) {
      categorizedError.recoveryActions = [
        ...categorizedError.recoveryActions,
        ...(this.props.recoveryActions[categorizedError.category] || []),
      ];
    }

    this.setState({ error: categorizedError });
    this.props.onError?.(categorizedError, errorInfo);

    logger.error('ErrorRecovery caught:', {
      category: categorizedError.category,
      message: categorizedError.userMessage,
      technical: categorizedError.technicalDetails,
    });
  }

  override componentDidUpdate(prevProps: ErrorRecoveryProps): void {
    const { resetKeys } = this.props;
    const { hasError } = this.state;

    if (hasError && prevProps.resetKeys !== resetKeys) {
      if (resetKeys?.some((key, index) => prevProps.resetKeys?.[index] !== key)) {
        this.handleReset();
      }
    }
  }

  override componentWillUnmount(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
    if (this.countdownIntervalId) {
      clearInterval(this.countdownIntervalId);
      this.countdownIntervalId = null;
    }
  }

  private calculateRetryDelay(): number {
    const { retryDelay = 1000, maxRetryDelay = 30000 } = this.props;
    const { retryCount } = this.state;

    // Exponential backoff: delay * 2^retryCount
    const delay = retryDelay * Math.pow(2, retryCount);
    return Math.min(delay, maxRetryDelay);
  }

  handleRetry = (): void => {
    const { maxRetries = 3 } = this.props;
    const { retryCount, error } = this.state;

    if (retryCount >= maxRetries || !error?.isRetryable) {
      return;
    }

    const delay = this.calculateRetryDelay();

    this.setState({
      isRetrying: true,
      retryIn: Math.ceil(delay / 1000),
    });

    // Start countdown
    this.countdownIntervalId = setInterval(() => {
      this.setState((s) => {
        const newRetryIn = s.retryIn !== null ? s.retryIn - 1 : null;
        if (newRetryIn !== null && newRetryIn <= 0) {
          this.clearTimers();
        }
        return { retryIn: newRetryIn };
      });
    }, 1000);

    // Schedule retry
    this.retryTimeoutId = setTimeout(() => {
      this.clearTimers();
      this.setState((s) => ({
        hasError: false,
        error: null,
        isRetrying: false,
        retryIn: null,
        retryCount: s.retryCount + 1,
      }));
    }, delay);
  };

  handleReset = (): void => {
    this.clearTimers();
    this.setState({
      hasError: false,
      error: null,
      retryCount: 0,
      isRetrying: false,
      retryIn: null,
    });
    this.props.onReset?.();
  };

  handleGoHome = (): void => {
    // Reset and navigate to home/terminal view
    this.handleReset();
    // This could dispatch to app store if needed
  };

  handleGoBack = (): void => {
    // Reset and go back
    this.handleReset();
    window.history.back();
  };

  override render(): ReactNode {
    const { hasError, error, retryCount, isRetrying, retryIn } = this.state;
    const {
      children,
      maxRetries = 3,
      showTechnicalDetails = true,
      renderError,
      fullPage = false,
    } = this.props;

    if (!hasError || !error) {
      return children;
    }

    // Custom render
    if (renderError) {
      return renderError({
        error,
        retryCount,
        maxRetries,
        isRetrying,
        retryIn,
        onRetry: this.handleRetry,
        onReset: this.handleReset,
        onGoHome: this.handleGoHome,
        onGoBack: this.handleGoBack,
      });
    }

    const canRetry = error.isRetryable && retryCount < maxRetries && !isRetrying;
    const retriesExhausted = retryCount >= maxRetries;

    const content = (
      <div
        role="alert"
        aria-live="assertive"
        className={clsx(
          'flex flex-col items-center justify-center text-center',
          fullPage ? 'min-h-screen p-8' : 'min-h-[300px] p-8'
        )}
      >
        {/* Icon */}
        <div className="text-error-500 mb-6">
          <ErrorIcon category={error.category} />
        </div>

        {/* Title */}
        <h2 className="text-xl font-semibold text-surface-100 mb-2">
          {getCategoryTitle(error.category)}
        </h2>

        {/* Message */}
        <p className="text-surface-400 mb-6 max-w-md">
          {error.userMessage}
        </p>

        {/* Retry countdown */}
        {isRetrying && retryIn !== null && (
          <div className="flex items-center gap-2 text-surface-400 mb-4">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>Retrying in {retryIn} second{retryIn !== 1 ? 's' : ''}...</span>
          </div>
        )}

        {/* Status badge */}
        {retryCount > 0 && !isRetrying && (
          <div className="mb-4">
            <span className="text-sm text-surface-500">
              Retry attempt {retryCount} of {maxRetries}
              {retriesExhausted && ' (exhausted)'}
            </span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
          {/* Retry button */}
          {canRetry && (
            <button
              onClick={this.handleRetry}
              className="btn btn-primary flex items-center gap-2"
              disabled={isRetrying}
            >
              <RefreshCw className="w-4 h-4" />
              Try Again
            </button>
          )}

          {/* Custom recovery actions */}
          {error.recoveryActions.map((action) => (
            <button
              key={action.id}
              onClick={action.action}
              className={clsx(
                'btn flex items-center gap-2',
                action.isPrimary ? 'btn-primary' : 'btn-secondary'
              )}
            >
              {action.icon}
              {action.label}
            </button>
          ))}

          {/* Default actions when retries exhausted */}
          {retriesExhausted && (
            <>
              <button
                onClick={this.handleReset}
                className="btn btn-secondary flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Start Fresh
              </button>
              <button
                onClick={this.handleGoHome}
                className="btn btn-secondary flex items-center gap-2"
              >
                <Home className="w-4 h-4" />
                Go Home
              </button>
            </>
          )}

          {/* Go back button for non-retryable errors */}
          {!error.isRetryable && (
            <button
              onClick={this.handleGoBack}
              className="btn btn-secondary flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Go Back
            </button>
          )}
        </div>

        {/* Technical details */}
        {showTechnicalDetails && (
          <details className="text-left max-w-lg w-full">
            <summary className="cursor-pointer text-sm text-surface-500 hover:text-surface-300">
              Technical details
            </summary>
            <pre className="mt-2 p-4 bg-surface-900 rounded-lg text-xs text-error-400 overflow-auto max-h-40 whitespace-pre-wrap">
              {error.technicalDetails}
            </pre>
          </details>
        )}

        {/* Online status indicator for network errors */}
        {error.category === 'network' && (
          <div className="mt-4 flex items-center gap-2 text-sm">
            <NetworkStatus />
          </div>
        )}
      </div>
    );

    return content;
  }
}

// ============================================================================
// Helper Components
// ============================================================================

function getCategoryTitle(category: ErrorCategory): string {
  switch (category) {
    case 'network':
      return 'Connection Problem';
    case 'auth':
      return 'Authentication Required';
    case 'data':
      return 'Data Error';
    case 'runtime':
      return 'Application Error';
    default:
      return 'Something Went Wrong';
  }
}

function NetworkStatus() {
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  return (
    <span
      className={clsx(
        'flex items-center gap-1',
        isOnline ? 'text-success-500' : 'text-error-500'
      )}
    >
      {isOnline ? (
        <>
          <Wifi className="w-4 h-4" />
          <span>You are online</span>
        </>
      ) : (
        <>
          <WifiOff className="w-4 h-4" />
          <span>You are offline</span>
        </>
      )}
    </span>
  );
}

// ============================================================================
// Hook for Imperative Error Throwing
// ============================================================================

export function useErrorRecovery(): (error: Error) => never {
  return (error: Error) => {
    throw error;
  };
}

// ============================================================================
// Utility: Wrap Async Operations
// ============================================================================

export async function withErrorRecovery<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    retryDelay?: number;
    onRetry?: (attempt: number, error: Error) => void;
    shouldRetry?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    onRetry,
    shouldRetry = () => true,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries && shouldRetry(lastError)) {
        const delay = retryDelay * Math.pow(2, attempt);
        onRetry?.(attempt + 1, lastError);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
