// ============================================================================
// GITHUB DEVICE FLOW LOGIN COMPONENT
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import { ExternalLink, Check, X, AlertCircle, Loader2 } from 'lucide-react';
import type {
  GitHubUser,
  DeviceFlowState,
  DeviceFlowStartResult,
} from '../../../shared/types/github';
import { createLogger } from '../../../shared/logger';
import { CopyButton } from '../common/CopyButton';
import { LoadingSpinner } from '../common/LoadingSpinner';

const logger = createLogger('DeviceFlowLogin');

// ============================================================================
// TYPES
// ============================================================================

interface DeviceFlowLoginProps {
  /** Callback when authentication completes successfully */
  onAuthSuccess?: (user: GitHubUser) => void;
  /** Callback when authentication fails or is cancelled */
  onAuthError?: (error: string) => void;
  /** Callback when user cancels the flow */
  onCancel?: () => void;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show in compact mode (for embedding in panels) */
  compact?: boolean;
  /** Whether to automatically open browser */
  autoOpenBrowser?: boolean;
}

type FlowStep = 'idle' | 'loading' | 'code_display' | 'polling' | 'success' | 'error';

interface FlowState {
  step: FlowStep;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: number | null;
  user: GitHubUser | null;
  error: string | null;
}

// ============================================================================
// GITHUB ICON
// ============================================================================

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
      />
    </svg>
  );
}

// ============================================================================
// COUNTDOWN HOOK
// ============================================================================

function useCountdown(expiresAt: number | null): number {
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  useEffect(() => {
    if (!expiresAt) {
      setSecondsRemaining(0);
      return;
    }

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  return secondsRemaining;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function DeviceFlowLogin({
  onAuthSuccess,
  onAuthError,
  onCancel,
  className,
  compact = false,
  autoOpenBrowser = true,
}: DeviceFlowLoginProps) {
  const [flowState, setFlowState] = useState<FlowState>({
    step: 'idle',
    userCode: null,
    verificationUri: null,
    expiresAt: null,
    user: null,
    error: null,
  });

  const isMountedRef = useRef(true);
  const pollingAbortedRef = useRef(false);

  const secondsRemaining = useCountdown(flowState.expiresAt);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      pollingAbortedRef.current = true;
      // Cancel any active device flow when unmounting
      window.goodvibes.githubDeviceFlowCancel?.().catch(() => {
        // Ignore errors on cleanup
      });
    };
  }, []);

  // Subscribe to device flow state changes
  useEffect(() => {
    const unsubscribe = window.goodvibes.onDeviceFlowStateChange?.((state: unknown) => {
      if (!isMountedRef.current) return;

      const typedState = state as DeviceFlowState;
      logger.debug('Device flow state changed:', typedState);

      if (typedState.status === 'expired') {
        setFlowState((prev) => ({
          ...prev,
          step: 'error',
          error: 'The code has expired. Please try again.',
        }));
        onAuthError?.('The code has expired. Please try again.');
      } else if (typedState.status === 'cancelled') {
        setFlowState((prev) => ({
          ...prev,
          step: 'idle',
          error: null,
        }));
      } else if (typedState.status === 'error' && typedState.error) {
        setFlowState((prev) => ({
          ...prev,
          step: 'error',
          error: typedState.error,
        }));
        onAuthError?.(typedState.error);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [onAuthError]);

  // Handle code expiration
  useEffect(() => {
    if (flowState.step === 'code_display' || flowState.step === 'polling') {
      if (secondsRemaining === 0 && flowState.expiresAt) {
        setFlowState((prev) => ({
          ...prev,
          step: 'error',
          error: 'The code has expired. Please try again.',
        }));
        onAuthError?.('The code has expired. Please try again.');
      }
    }
  }, [secondsRemaining, flowState.step, flowState.expiresAt, onAuthError]);

  const startDeviceFlow = useCallback(async () => {
    setFlowState({
      step: 'loading',
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      user: null,
      error: null,
    });
    pollingAbortedRef.current = false;

    try {
      const result: DeviceFlowStartResult = await window.goodvibes.githubDeviceFlowStart({
        openBrowser: autoOpenBrowser,
      });

      if (!isMountedRef.current) return;

      if (!result.success || !result.userCode || !result.verificationUri) {
        setFlowState((prev) => ({
          ...prev,
          step: 'error',
          error: result.error || 'Failed to start device flow',
        }));
        onAuthError?.(result.error || 'Failed to start device flow');
        return;
      }

      const expiresAt = result.expiresIn
        ? Date.now() + result.expiresIn * 1000
        : Date.now() + 900000; // Default 15 minutes

      setFlowState({
        step: 'code_display',
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        expiresAt,
        user: null,
        error: null,
      });

      // Start polling for completion
      await pollForCompletion();
    } catch (err) {
      if (!isMountedRef.current) return;
      const errorMessage = err instanceof Error ? err.message : 'Failed to start device flow';
      logger.error('Device flow start error:', err);
      setFlowState((prev) => ({
        ...prev,
        step: 'error',
        error: errorMessage,
      }));
      onAuthError?.(errorMessage);
    }
  }, [autoOpenBrowser, onAuthError]);

  const pollForCompletion = useCallback(async () => {
    if (!isMountedRef.current) return;

    setFlowState((prev) => ({
      ...prev,
      step: 'polling',
    }));

    try {
      const result = await window.goodvibes.githubDeviceFlowWait();

      if (!isMountedRef.current || pollingAbortedRef.current) return;

      if (result.success && result.user) {
        setFlowState((prev) => ({
          ...prev,
          step: 'success',
          user: result.user,
          error: null,
        }));
        onAuthSuccess?.(result.user);
      } else if (result.error) {
        // Handle specific error cases
        if (result.error.includes('expired')) {
          setFlowState((prev) => ({
            ...prev,
            step: 'error',
            error: 'The code has expired. Please try again.',
          }));
        } else if (result.error.includes('denied') || result.error.includes('access_denied')) {
          setFlowState((prev) => ({
            ...prev,
            step: 'error',
            error: 'Access was denied. Please try again and authorize the application.',
          }));
        } else {
          setFlowState((prev) => ({
            ...prev,
            step: 'error',
            error: result.error,
          }));
        }
        onAuthError?.(result.error);
      }
    } catch (err) {
      if (!isMountedRef.current || pollingAbortedRef.current) return;
      const errorMessage = err instanceof Error ? err.message : 'Polling failed';
      logger.error('Device flow polling error:', err);
      setFlowState((prev) => ({
        ...prev,
        step: 'error',
        error: errorMessage,
      }));
      onAuthError?.(errorMessage);
    }
  }, [onAuthSuccess, onAuthError]);

  const handleCancel = useCallback(async () => {
    pollingAbortedRef.current = true;
    try {
      await window.goodvibes.githubDeviceFlowCancel?.();
    } catch {
      // Ignore cancel errors
    }
    setFlowState({
      step: 'idle',
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      user: null,
      error: null,
    });
    onCancel?.();
  }, [onCancel]);

  const handleRetry = useCallback(() => {
    startDeviceFlow();
  }, [startDeviceFlow]);

  const openVerificationUrl = useCallback(() => {
    if (flowState.verificationUri) {
      window.open(flowState.verificationUri, '_blank');
    }
  }, [flowState.verificationUri]);

  // ============================================================================
  // RENDER: IDLE STATE
  // ============================================================================

  if (flowState.step === 'idle') {
    return (
      <div className={clsx('flex flex-col items-center gap-4', className)}>
        <button
          onClick={startDeviceFlow}
          className={clsx(
            'btn btn-primary flex items-center gap-2',
            compact ? 'btn-sm' : ''
          )}
        >
          <GitHubIcon className="w-5 h-5" />
          Login with GitHub
        </button>
        {!compact && (
          <p className="text-xs text-surface-500 text-center max-w-xs">
            You will be given a code to enter on GitHub.com to authorize this application.
          </p>
        )}
      </div>
    );
  }

  // ============================================================================
  // RENDER: LOADING STATE
  // ============================================================================

  if (flowState.step === 'loading') {
    return (
      <div className={clsx('flex flex-col items-center gap-4 py-8', className)}>
        <LoadingSpinner size="lg" />
        <p className="text-sm text-surface-400">Starting GitHub login...</p>
      </div>
    );
  }

  // ============================================================================
  // RENDER: CODE DISPLAY / POLLING STATE
  // ============================================================================

  if (flowState.step === 'code_display' || flowState.step === 'polling') {
    const isPolling = flowState.step === 'polling';

    return (
      <div className={clsx('flex flex-col', compact ? 'gap-4' : 'gap-6', className)}>
        {/* Header */}
        <div className="text-center">
          <h3 className={clsx('font-semibold text-surface-100', compact ? 'text-base' : 'text-lg')}>
            {isPolling ? 'Waiting for authorization...' : 'Enter this code on GitHub'}
          </h3>
          {!compact && (
            <p className="text-sm text-surface-400 mt-1">
              {isPolling
                ? 'Complete the authorization in your browser'
                : 'Copy the code below and enter it on GitHub to authorize'}
            </p>
          )}
        </div>

        {/* User Code Display */}
        <div className="flex flex-col items-center gap-3">
          <div
            className={clsx(
              'relative bg-surface-800 border-2 border-primary-500/50 rounded-lg',
              compact ? 'px-4 py-3' : 'px-6 py-4'
            )}
          >
            <code
              className={clsx(
                'font-mono font-bold tracking-[0.3em] text-primary-400 select-all',
                compact ? 'text-2xl' : 'text-3xl'
              )}
              aria-label={`Your code is ${flowState.userCode?.split('').join(' ')}`}
            >
              {flowState.userCode}
            </code>
            {/* Copy button positioned in corner */}
            <div className="absolute -top-2 -right-2">
              <CopyButton
                content={flowState.userCode || ''}
                iconOnly
                size="sm"
                className="bg-surface-700 rounded-full shadow-lg"
              />
            </div>
          </div>

          {/* Large copy button below */}
          <CopyButton
            content={flowState.userCode || ''}
            label="Copy Code"
            size="md"
            className="opacity-100"
          />
        </div>

        {/* Verification URL */}
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-surface-400">Then visit:</p>
          <a
            href={flowState.verificationUri || '#'}
            onClick={(e) => {
              e.preventDefault();
              openVerificationUrl();
            }}
            className={clsx(
              'flex items-center gap-2 text-primary-400 hover:text-primary-300 transition-colors',
              compact ? 'text-sm' : 'text-base'
            )}
          >
            <ExternalLink className="w-4 h-4" />
            <span className="font-medium">{flowState.verificationUri}</span>
          </a>
          <button
            onClick={openVerificationUrl}
            className="btn btn-secondary btn-sm flex items-center gap-2 mt-1"
          >
            <ExternalLink className="w-4 h-4" />
            Open in Browser
          </button>
        </div>

        {/* Countdown Timer */}
        <div className="flex flex-col items-center gap-1">
          <div
            className={clsx(
              'flex items-center gap-2',
              secondsRemaining < 60 ? 'text-warning-400' : 'text-surface-400'
            )}
          >
            {isPolling && <Loader2 className="w-4 h-4 animate-spin" />}
            <span className="text-sm">
              {isPolling ? 'Waiting for authorization' : 'Code expires in'}
            </span>
            <span className={clsx('font-mono font-medium', compact ? 'text-sm' : 'text-base')}>
              {formatTime(secondsRemaining)}
            </span>
          </div>
          {secondsRemaining < 60 && (
            <p className="text-xs text-warning-400">Code expiring soon!</p>
          )}
        </div>

        {/* Cancel Button */}
        <div className="flex justify-center">
          <button
            onClick={handleCancel}
            className="btn btn-ghost btn-sm flex items-center gap-2 text-surface-400 hover:text-surface-200"
          >
            <X className="w-4 h-4" />
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ============================================================================
  // RENDER: SUCCESS STATE
  // ============================================================================

  if (flowState.step === 'success' && flowState.user) {
    return (
      <div className={clsx('flex flex-col items-center gap-4', className)}>
        {/* Success indicator */}
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-success-500/20 border-2 border-success-500">
          <Check className="w-8 h-8 text-success-400" />
        </div>

        {/* User info */}
        <div className="flex flex-col items-center gap-2 text-center">
          <img
            src={flowState.user.avatar_url}
            alt={flowState.user.login}
            className="w-12 h-12 rounded-full bg-surface-700"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <div>
            <h3 className="font-semibold text-surface-100">
              Welcome, {flowState.user.name || flowState.user.login}!
            </h3>
            <p className="text-sm text-surface-400">@{flowState.user.login}</p>
          </div>
        </div>

        <p className="text-sm text-success-400">Successfully connected to GitHub</p>
      </div>
    );
  }

  // ============================================================================
  // RENDER: ERROR STATE
  // ============================================================================

  if (flowState.step === 'error') {
    return (
      <div className={clsx('flex flex-col items-center gap-4', className)}>
        {/* Error indicator */}
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-error-500/20 border-2 border-error-500">
          <AlertCircle className="w-8 h-8 text-error-400" />
        </div>

        {/* Error message */}
        <div className="flex flex-col items-center gap-2 text-center">
          <h3 className="font-semibold text-surface-100">Authentication Failed</h3>
          <p className="text-sm text-error-400 max-w-xs">{flowState.error}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button onClick={handleCancel} className="btn btn-secondary btn-sm">
            Cancel
          </button>
          <button onClick={handleRetry} className="btn btn-primary btn-sm">
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ============================================================================
// COMPACT DEVICE FLOW LOGIN (for embedding in panels)
// ============================================================================

export function DeviceFlowLoginCompact(
  props: Omit<DeviceFlowLoginProps, 'compact'>
) {
  return <DeviceFlowLogin {...props} compact />;
}

export default DeviceFlowLogin;
