// ============================================================================
// TOAST NOTIFICATION COMPONENT
// Modern glass morphism toasts with progress bar and stacking
// ============================================================================

import React, { useEffect, useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { useToastStore, type Toast as ToastType, type ToastType as ToastVariant } from '../../stores/toastStore';

// Toast type configuration for colors and icons
const TOAST_CONFIG: Record<ToastVariant, {
  icon: React.ReactNode;
  borderColor: string;
  glowColor: string;
  iconBg: string;
}> = {
  success: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    ),
    borderColor: 'border-l-emerald-500',
    glowColor: 'shadow-[0_0_20px_rgba(16,185,129,0.15)]',
    iconBg: 'bg-emerald-500/20 text-emerald-400',
  },
  error: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    borderColor: 'border-l-rose-500',
    glowColor: 'shadow-[0_0_20px_rgba(244,63,94,0.15)]',
    iconBg: 'bg-rose-500/20 text-rose-400',
  },
  warning: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    borderColor: 'border-l-amber-500',
    glowColor: 'shadow-[0_0_20px_rgba(245,158,11,0.15)]',
    iconBg: 'bg-amber-500/20 text-amber-400',
  },
  info: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    borderColor: 'border-l-indigo-500',
    glowColor: 'shadow-[0_0_20px_rgba(99,102,241,0.15)]',
    iconBg: 'bg-indigo-500/20 text-indigo-400',
  },
};

// Progress bar colors by type
const PROGRESS_COLORS: Record<ToastVariant, string> = {
  success: 'bg-gradient-to-r from-emerald-500 to-emerald-400',
  error: 'bg-gradient-to-r from-rose-500 to-rose-400',
  warning: 'bg-gradient-to-r from-amber-500 to-amber-400',
  info: 'bg-gradient-to-r from-indigo-500 to-indigo-400',
};

export function ToastContainer(): React.JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col-reverse gap-3 max-w-sm pointer-events-none">
      {toasts.map((toast, index) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onClose={() => removeToast(toast.id)}
          index={index}
        />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: ToastType;
  onClose: () => void;
  index: number;
}

function ToastItem({ toast, onClose, index }: ToastItemProps) {
  const [isExiting, setIsExiting] = useState(false);
  const [progress, setProgress] = useState(100);
  const [isPaused, setIsPaused] = useState(false);

  const duration = toast.duration ?? 5000;
  const config = TOAST_CONFIG[toast.type];

  const handleClose = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      onClose();
    }, 200);
  }, [onClose]);

  // Progress bar countdown
  useEffect(() => {
    if (duration <= 0 || isPaused) return;

    const startTime = Date.now();
    const initialProgress = progress;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const remaining = initialProgress - (elapsed / duration) * 100;

      if (remaining <= 0) {
        setProgress(0);
        handleClose();
        return;
      }

      setProgress(remaining);
      requestAnimationFrame(animate);
    };

    const frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [duration, isPaused, handleClose, progress]);

  // Stack offset calculation for visual depth
  const stackOffset = Math.min(index, 3);
  const scale = 1 - stackOffset * 0.03;
  const translateY = stackOffset * 8;

  return (
    <div
      role="alert"
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      className={clsx(
        'toast-item pointer-events-auto relative overflow-hidden',
        'rounded-xl border-l-4',
        // Glass morphism effect
        'bg-surface-900/80 backdrop-blur-xl',
        'border border-surface-700/50',
        // Type-specific border and glow
        config.borderColor,
        config.glowColor,
        // Animation states
        isExiting ? 'toast-exit' : 'toast-enter',
        // Shadow for depth
        'shadow-xl shadow-black/20'
      )}
      style={{
        transform: `scale(${scale}) translateY(${translateY}px)`,
        zIndex: 10 - index,
        opacity: index > 2 ? 0 : 1,
      }}
    >
      {/* Main content area */}
      <div className="flex items-start gap-3 p-4">
        {/* Icon with glow background */}
        <div className={clsx(
          'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
          'transition-transform duration-200',
          config.iconBg,
          isPaused && 'scale-110'
        )}>
          {config.icon}
        </div>

        {/* Text content */}
        <div className="flex-1 min-w-0 pt-0.5">
          {toast.title && (
            <h4 className="text-sm font-semibold text-surface-50 mb-0.5">
              {toast.title}
            </h4>
          )}
          <p className="text-sm text-surface-300 leading-relaxed">
            {toast.message}
          </p>
          {toast.action && (
            <button
              onClick={toast.action.onClick}
              className={clsx(
                'mt-2 text-sm font-medium transition-all duration-200',
                'text-indigo-400 hover:text-indigo-300',
                'hover:underline underline-offset-2'
              )}
            >
              {toast.action.label}
            </button>
          )}
        </div>

        {/* Close button */}
        <button
          onClick={handleClose}
          className={clsx(
            'flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
            'text-surface-500 hover:text-surface-200',
            'hover:bg-surface-700/50 transition-all duration-200',
            'opacity-0 group-hover:opacity-100',
            isPaused && 'opacity-100'
          )}
          aria-label="Dismiss notification"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      {duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-surface-800/50 overflow-hidden">
          <div
            className={clsx(
              'h-full transition-none',
              PROGRESS_COLORS[toast.type],
              // Glow effect on the leading edge
              'shadow-[0_0_8px_currentColor]'
            )}
            style={{
              width: `${progress}%`,
              transition: isPaused ? 'none' : undefined,
            }}
          />
        </div>
      )}
    </div>
  );
}
