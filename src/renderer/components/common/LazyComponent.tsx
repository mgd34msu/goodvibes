// ============================================================================
// LAZY COMPONENT WRAPPER
// React.lazy with Suspense, error boundary, and prefetch support
// ============================================================================

import {
  lazy,
  Suspense,
  Component,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
  type LazyExoticComponent,
  type ComponentType,
  type ErrorInfo,
} from 'react';
import { clsx } from 'clsx';
import { Skeleton } from './Skeleton';
import { LoadingSpinner } from './LoadingSpinner';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('LazyComponent');

// ============================================================================
// Types
// ============================================================================

export interface LazyComponentProps {
  /** The lazy component to render */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: LazyExoticComponent<ComponentType<any>>;
  /** Props to pass to the component */
  componentProps?: Record<string, unknown>;
  /** Custom loading fallback */
  fallback?: ReactNode;
  /** Fallback type: spinner, skeleton, or custom */
  fallbackType?: 'spinner' | 'skeleton' | 'none';
  /** Skeleton variant for skeleton fallback */
  skeletonVariant?: 'text' | 'circular' | 'rectangular';
  /** Skeleton height */
  skeletonHeight?: number | string;
  /** Skeleton lines (for text variant) */
  skeletonLines?: number;
  /** Whether to show error UI on load failure */
  showErrorUI?: boolean;
  /** Callback when component fails to load */
  onError?: (error: Error) => void;
  /** Retry attempts for loading */
  retryAttempts?: number;
  /** Delay between retries in ms */
  retryDelay?: number;
  /** Container className */
  className?: string;
  /** Minimum loading time to prevent flash */
  minLoadingTime?: number;
}

interface LazyErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

interface LazyErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error) => void;
  onRetry?: () => void;
  maxRetries?: number;
  retryDelay?: number;
  showErrorUI?: boolean;
}

// ============================================================================
// Error Boundary for Lazy Loading
// ============================================================================

class LazyErrorBoundary extends Component<LazyErrorBoundaryProps, LazyErrorBoundaryState> {
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(props: LazyErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<LazyErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error('LazyComponent failed to load:', error, errorInfo);
    this.props.onError?.(error);
  }

  override componentWillUnmount(): void {
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
    }
  }

  handleRetry = (): void => {
    const { maxRetries = 3, retryDelay = 1000, onRetry } = this.props;
    const { retryCount } = this.state;

    if (retryCount < maxRetries) {
      this.retryTimeoutId = setTimeout(() => {
        this.setState((s) => ({
          hasError: false,
          error: null,
          retryCount: s.retryCount + 1,
        }));
        onRetry?.();
      }, retryDelay * Math.pow(2, retryCount)); // Exponential backoff
    }
  };

  override render(): ReactNode {
    const { hasError, error, retryCount } = this.state;
    const { children, maxRetries = 3, showErrorUI = true } = this.props;

    if (hasError && showErrorUI) {
      return (
        <div
          role="alert"
          className="flex flex-col items-center justify-center p-8 text-center"
        >
          <div className="text-error-500 mb-4">
            <svg
              className="w-12 h-12 mx-auto"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>

          <h3 className="text-lg font-medium text-surface-100 mb-2">
            Failed to load component
          </h3>

          <p className="text-sm text-surface-400 mb-4 max-w-sm">
            {error?.message || 'An unexpected error occurred while loading this component.'}
          </p>

          {retryCount < maxRetries && (
            <button
              onClick={this.handleRetry}
              className="btn btn-primary"
            >
              Retry ({maxRetries - retryCount} attempts remaining)
            </button>
          )}

          {retryCount >= maxRetries && (
            <p className="text-sm text-surface-500">
              Maximum retry attempts reached. Please refresh the page.
            </p>
          )}
        </div>
      );
    }

    if (hasError && !showErrorUI) {
      return null;
    }

    return children;
  }
}

// ============================================================================
// Default Loading Fallback
// ============================================================================

function DefaultLoadingFallback({
  type = 'spinner',
  skeletonVariant = 'rectangular',
  skeletonHeight = 200,
  skeletonLines = 3,
}: {
  type?: 'spinner' | 'skeleton' | 'none';
  skeletonVariant?: 'text' | 'circular' | 'rectangular';
  skeletonHeight?: number | string;
  skeletonLines?: number;
}) {
  if (type === 'none') {
    return null;
  }

  if (type === 'skeleton') {
    return (
      <div className="p-4 space-y-4" role="progressbar" aria-label="Loading content">
        {skeletonVariant === 'text' ? (
          <Skeleton variant="text" lines={skeletonLines} />
        ) : (
          <Skeleton variant={skeletonVariant} height={skeletonHeight} />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-8" role="progressbar" aria-label="Loading component">
      <LoadingSpinner size="lg" />
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function LazyComponent({
  component: LazyComp,
  componentProps,
  fallback,
  fallbackType = 'spinner',
  skeletonVariant,
  skeletonHeight,
  skeletonLines,
  showErrorUI = true,
  onError,
  retryAttempts = 3,
  retryDelay = 1000,
  className,
  minLoadingTime = 0,
}: LazyComponentProps) {
  const [, setRetryKey] = useState(0);

  const handleRetry = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

  const loadingFallback = fallback || (
    <DefaultLoadingFallback
      type={fallbackType}
      skeletonVariant={skeletonVariant}
      skeletonHeight={skeletonHeight}
      skeletonLines={skeletonLines}
    />
  );

  return (
    <div className={clsx(className)}>
      <LazyErrorBoundary
        onError={onError}
        onRetry={handleRetry}
        maxRetries={retryAttempts}
        retryDelay={retryDelay}
        showErrorUI={showErrorUI}
      >
        <Suspense fallback={loadingFallback}>
          <MinLoadingTime minTime={minLoadingTime}>
            <LazyComp {...(componentProps as Record<string, unknown>)} />
          </MinLoadingTime>
        </Suspense>
      </LazyErrorBoundary>
    </div>
  );
}

// ============================================================================
// Minimum Loading Time Wrapper
// Prevents flash of loading state for fast loads
// ============================================================================

function MinLoadingTime({
  children,
  minTime,
}: {
  children: ReactNode;
  minTime: number;
}) {
  const [ready, setReady] = useState(minTime <= 0);

  useEffect(() => {
    if (minTime > 0) {
      const timer = setTimeout(() => setReady(true), minTime);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [minTime]);

  if (!ready) {
    return null;
  }

  return <>{children}</>;
}

// ============================================================================
// Prefetch Utilities
// ============================================================================

type LazyComponentLoader = () => Promise<{ default: ComponentType<unknown> }>;

const prefetchedComponents = new Set<LazyComponentLoader>();

/**
 * Prefetch a lazy component to load it before it's needed
 */
export function prefetchComponent(loader: LazyComponentLoader): void {
  if (!prefetchedComponents.has(loader)) {
    prefetchedComponents.add(loader);
    loader().catch((err) => {
      logger.warn('Failed to prefetch component:', err);
      prefetchedComponents.delete(loader);
    });
  }
}

/**
 * Create a lazy component with prefetch support
 */
export function createLazyComponent<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>
): LazyExoticComponent<T> & { prefetch: () => void } {
  const LazyComp = lazy(loader) as LazyExoticComponent<T> & { prefetch: () => void };
  LazyComp.prefetch = () => prefetchComponent(loader as LazyComponentLoader);
  return LazyComp;
}

// ============================================================================
// Hover Prefetch Hook
// ============================================================================

interface UsePrefetchOnHoverOptions {
  /** Delay before prefetching in ms */
  delay?: number;
  /** Whether prefetching is enabled */
  enabled?: boolean;
}

export function usePrefetchOnHover(
  loader: LazyComponentLoader,
  options: UsePrefetchOnHoverOptions = {}
): {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
} {
  const { delay = 150, enabled = true } = options;
  const [timeoutId, setTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);

  const startPrefetch = useCallback(() => {
    if (!enabled) return;

    const id = setTimeout(() => {
      prefetchComponent(loader);
    }, delay);
    setTimeoutId(id);
  }, [loader, delay, enabled]);

  const cancelPrefetch = useCallback(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      setTimeoutId(null);
    }
  }, [timeoutId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [timeoutId]);

  return {
    onMouseEnter: startPrefetch,
    onMouseLeave: cancelPrefetch,
    onFocus: startPrefetch,
  };
}

// ============================================================================
// Re-exports
// ============================================================================

export { lazy, Suspense };
