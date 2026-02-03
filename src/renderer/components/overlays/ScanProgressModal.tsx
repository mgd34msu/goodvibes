// ============================================================================
// SCAN PROGRESS MODAL COMPONENT
// Real-time progress display for AI tag suggestion scanning
// ============================================================================

import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Sparkles, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { FocusTrap } from '../common/FocusTrap';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { LoadingSpinner } from '../common/LoadingSpinner';
import type { ScanProgress } from '../../../shared/types/index.js';

interface ScanProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCancel: () => void;
}

/**
 * Format milliseconds to human-readable time estimate
 */
function formatTimeRemaining(ms: number | null): string {
  if (!ms || ms <= 0) return 'Calculating...';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `~${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `~${minutes}m ${seconds % 60}s`;
  }
  return `~${seconds}s`;
}

/**
 * Truncate session ID for display
 */
function truncateSessionId(sessionId: string | null): string {
  if (!sessionId) return 'None';
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

export function ScanProgressModal({
  isOpen,
  onClose,
  onCancel,
}: ScanProgressModalProps) {
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [scanCounts, setScanCounts] = useState<{ pending: number; completed: number; failed: number } | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Fetch scan progress and status from main process
   */
  const fetchScanData = useCallback(async () => {
    try {
      const [progressRes, countsRes] = await Promise.all([
        window.goodvibes.getScanProgress(),
        window.goodvibes.getScanCounts(),
      ]);

      if (progressRes.success && progressRes.data) {
        setProgress(progressRes.data);
      }

      if (countsRes.success && countsRes.data) {
        setScanCounts(countsRes.data);
        
        // Check if scan completed (when no pending sessions)
        if (countsRes.data.pending === 0 && progressRes.data?.current === progressRes.data?.total && progressRes.data.total > 0) {
          setIsComplete(true);
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch scan data:', err);
      setError('Failed to fetch scan progress');
    }
  }, []);

  /**
   * Handle cancel button click
   */
  const handleCancel = useCallback(async () => {
    setIsCanceling(true);
    try {
      await window.goodvibes.stopBackgroundScan();
      onCancel();
    } catch (err) {
      console.error('Failed to cancel scan:', err);
      setError('Failed to cancel scan');
    } finally {
      setIsCanceling(false);
    }
  }, [onCancel]);

  /**
   * Handle close with completion check
   */
  const handleClose = useCallback(() => {
    if (isComplete) {
      onClose();
    }
  }, [isComplete, onClose]);

  /**
   * Set up polling when modal opens
   */
  useEffect(() => {
    if (!isOpen) {
      // Clean up when modal closes
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      // Reset state
      setProgress(null);
      setScanCounts(null);
      setIsComplete(false);
      setIsCanceling(false);
      setError(null);
      return;
    }

    // Initial fetch
    fetchScanData();

    // Poll every 500ms
    pollIntervalRef.current = setInterval(() => {
      fetchScanData();
    }, 500);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isOpen, fetchScanData]);

  /**
   * Listen for scan status events
   */
  useEffect(() => {
    if (!isOpen) return;

    const cleanup = window.goodvibes.onScanStatus((data) => {
      if (data.status === 'completed') {
        setIsComplete(true);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      }
    });

    return cleanup;
  }, [isOpen]);

  /**
   * Handle escape key
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isComplete) {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isComplete, handleClose]);

  if (!isOpen) return null;

  const percentage = progress?.percentage ?? 0;
  const current = progress?.current ?? 0;
  const total = progress?.total ?? 0;
  const timeRemaining = progress?.estimatedTimeMs ?? null;
  const currentSessionId = progress?.currentSessionId ?? null;

  return createPortal(
    <div className="modal-backdrop-premium" onClick={isComplete ? handleClose : undefined}>
      <FocusTrap>
        <ErrorBoundary
          fallback={
            <div className="modal-panel-premium modal-md">
              <div className="p-8 text-center">
                <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
                <p className="text-slate-400">Scan Progress Modal encountered an error</p>
                <button onClick={onClose} className="btn btn-secondary mt-4">
                  Close
                </button>
              </div>
            </div>
          }
          onReset={onClose}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="scan-progress-title"
            aria-describedby="scan-progress-description"
            className="modal-panel-premium modal-md"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="modal-header-premium">
              <div className="flex items-center gap-3">
                {isComplete ? (
                  <CheckCircle2 className="w-6 h-6 text-emerald-400" strokeWidth={1.5} />
                ) : (
                  <Sparkles className="w-6 h-6 text-violet-400 animate-pulse" strokeWidth={1.5} />
                )}
                <h2 id="scan-progress-title" className="text-xl font-semibold text-slate-100">
                  {isComplete ? 'Scan Complete!' : 'Scanning Sessions for Tag Suggestions'}
                </h2>
              </div>
              {isComplete && (
                <button
                  onClick={handleClose}
                  className="modal-close-btn"
                  aria-label="Close modal"
                >
                  <X className="w-5 h-5" strokeWidth={1.5} />
                </button>
              )}
            </div>

            {/* Body */}
            <div className="modal-body-premium">
              <div id="scan-progress-description" className="space-y-6">
                {/* Progress Bar */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Progress</span>
                    <span className="text-slate-200 font-medium">{percentage.toFixed(0)}%</span>
                  </div>
                  <div className="h-2 bg-surface-800 rounded-full overflow-hidden">
                    <div
                      className={clsx(
                        'h-full transition-all duration-300 ease-out',
                        isComplete
                          ? 'bg-emerald-500'
                          : 'bg-gradient-to-r from-violet-500 to-indigo-500 animate-pulse'
                      )}
                      style={{ width: `${percentage}%` }}
                      role="progressbar"
                      aria-valuenow={percentage}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    />
                  </div>
                </div>

                {/* Status Grid */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Sessions Scanned */}
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Sessions Scanned</div>
                    <div className="text-2xl font-semibold text-slate-100">
                      {current} <span className="text-base text-slate-400">/ {total}</span>
                    </div>
                  </div>

                  {/* Time Remaining */}
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Time Remaining</div>
                    <div className="text-2xl font-semibold text-slate-100">
                      {isComplete ? '0s' : formatTimeRemaining(timeRemaining)}
                    </div>
                  </div>

                  {/* Current Session */}
                  <div className="space-y-1 col-span-2">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Current Session</div>
                    <div className="text-sm text-slate-300 font-mono bg-surface-800/50 px-3 py-2 rounded-lg border border-surface-700/50">
                      {isComplete ? 'Complete' : truncateSessionId(currentSessionId)}
                    </div>
                  </div>

                  {/* Scan Progress */}
                  <div className="space-y-1 col-span-2">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Scan Statistics</div>
                    <div className="flex gap-6 text-sm">
                      <div>
                        <span className="text-slate-400">Completed:</span>
                        <span className="ml-2 text-emerald-400 font-semibold">{scanCounts?.completed ?? 0}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">Pending:</span>
                        <span className="ml-2 text-amber-400 font-semibold">{scanCounts?.pending ?? 0}</span>
                      </div>
                      {(scanCounts?.failed ?? 0) > 0 && (
                        <div>
                          <span className="text-slate-400">Failed:</span>
                          <span className="ml-2 text-red-400 font-semibold">{scanCounts?.failed}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Error Message */}
                {error && (
                  <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                    <div>
                      <div className="text-sm font-medium text-red-400 mb-1">Scan Error</div>
                      <div className="text-xs text-slate-400">{error}</div>
                    </div>
                  </div>
                )}

                {/* Completion Message */}
                {isComplete && !error && (
                  <div className="flex items-start gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                    <div>
                      <div className="text-sm font-medium text-emerald-400 mb-1">Scan Complete</div>
                      <div className="text-xs text-slate-400">
                        Successfully scanned {total} sessions and generated tag suggestions.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="modal-footer-premium">
              {isComplete ? (
                <button onClick={handleClose} className="btn btn-primary min-w-[120px]">
                  Close
                </button>
              ) : (
                <>
                  <button
                    onClick={handleCancel}
                    disabled={isCanceling}
                    className="btn btn-secondary min-w-[120px]"
                  >
                    {isCanceling ? (
                      <span className="flex items-center gap-2">
                        <LoadingSpinner size="xs" />
                        Canceling...
                      </span>
                    ) : (
                      'Cancel Scan'
                    )}
                  </button>
                  <button disabled className="btn btn-primary min-w-[120px] opacity-50 cursor-not-allowed">
                    <span className="flex items-center gap-2">
                      <LoadingSpinner size="xs" />
                      Running...
                    </span>
                  </button>
                </>
              )}
            </div>
          </div>
        </ErrorBoundary>
      </FocusTrap>
    </div>,
    document.body
  );
}
