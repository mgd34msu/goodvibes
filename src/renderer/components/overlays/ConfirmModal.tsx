// ============================================================================
// CONFIRM MODAL COMPONENT
// Premium cinematic modal for confirmation dialogs
// ============================================================================

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { FocusTrap } from '../common/FocusTrap';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'default' | 'success';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Focus the confirm button when modal opens
      confirmButtonRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const variantStyles = {
    danger: 'btn-danger',
    warning: 'btn-warning',
    default: 'btn-primary',
    success: 'btn-success',
  };

  const panelVariantClass = {
    danger: 'modal-danger',
    warning: 'modal-warning',
    default: '',
    success: 'modal-success',
  };

  const iconContainerClass = {
    danger: 'icon-danger',
    warning: 'icon-warning',
    default: 'icon-info',
    success: 'icon-success',
  };

  const iconColorClass = {
    danger: 'text-red-400',
    warning: 'text-amber-400',
    default: 'text-violet-400',
    success: 'text-emerald-400',
  };

  const renderIcon = () => {
    const iconProps = { className: `w-7 h-7 ${iconColorClass[variant]}`, strokeWidth: 1.5 };
    switch (variant) {
      case 'danger':
        return <AlertTriangle {...iconProps} />;
      case 'warning':
        return <AlertTriangle {...iconProps} />;
      case 'success':
        return <CheckCircle2 {...iconProps} />;
      default:
        return <Info {...iconProps} />;
    }
  };

  return createPortal(
    <div className="modal-backdrop-premium" onClick={onCancel}>
      {/* Modal Panel */}
      <FocusTrap>
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-modal-title"
          aria-describedby="confirm-modal-message"
          className={clsx(
            'modal-panel-premium modal-sm',
            panelVariantClass[variant]
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Content */}
          <div className="modal-body-premium text-center">
            {/* Icon */}
            <div className={clsx('modal-icon-container', iconContainerClass[variant])}>
              {renderIcon()}
            </div>

            {/* Title */}
            <h2
              id="confirm-modal-title"
              className="text-xl font-semibold text-slate-100 mb-2"
            >
              {title}
            </h2>

            {/* Message */}
            <p
              id="confirm-modal-message"
              className="text-sm text-slate-400 leading-relaxed max-w-sm mx-auto"
            >
              {message}
            </p>

            {/* Actions */}
            <div className="mt-8 flex gap-3 justify-center">
              <button
                onClick={onCancel}
                className="btn btn-secondary min-w-[100px]"
              >
                {cancelText}
              </button>
              <button
                ref={confirmButtonRef}
                onClick={onConfirm}
                className={clsx('btn min-w-[100px]', variantStyles[variant])}
              >
                {confirmText}
              </button>
            </div>
          </div>
        </div>
      </FocusTrap>
    </div>,
    document.body
  );
}

// ============================================================================
// HOOK FOR USING CONFIRM MODAL
// ============================================================================

interface UseConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'default';
}

interface UseConfirmResult {
  isOpen: boolean;
  confirm: () => Promise<boolean>;
  ConfirmDialog: () => React.JSX.Element | null;
}

export function useConfirm(options: UseConfirmOptions): UseConfirmResult {
  const [isOpen, setIsOpen] = React.useState(false);
  const resolveRef = React.useRef<((value: boolean) => void) | null>(null);

  const confirm = React.useCallback(() => {
    setIsOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleConfirm = React.useCallback(() => {
    setIsOpen(false);
    resolveRef.current?.(true);
    resolveRef.current = null;
  }, []);

  const handleCancel = React.useCallback(() => {
    setIsOpen(false);
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  const ConfirmDialog = React.useCallback(() => (
    <ConfirmModal
      isOpen={isOpen}
      title={options.title}
      message={options.message}
      confirmText={options.confirmText}
      cancelText={options.cancelText}
      variant={options.variant}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ), [isOpen, options, handleConfirm, handleCancel]);

  return { isOpen, confirm, ConfirmDialog };
}
