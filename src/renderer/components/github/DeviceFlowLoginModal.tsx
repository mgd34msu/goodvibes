// ============================================================================
// GITHUB DEVICE FLOW LOGIN MODAL
// Standalone modal for GitHub device flow authentication
// ============================================================================

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type { GitHubUser } from '../../../shared/types/github';
import { DeviceFlowLogin } from './DeviceFlowLogin';
import { FocusTrap } from '../common/FocusTrap';

// ============================================================================
// TYPES
// ============================================================================

interface DeviceFlowLoginModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback when authentication completes successfully */
  onAuthSuccess?: (user: GitHubUser) => void;
  /** Callback when authentication fails */
  onAuthError?: (error: string) => void;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function DeviceFlowLoginModal({
  isOpen,
  onClose,
  onAuthSuccess,
  onAuthError,
}: DeviceFlowLoginModalProps) {
  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAuthSuccess = (user: GitHubUser) => {
    onAuthSuccess?.(user);
    // Close modal after a brief delay to show success state
    setTimeout(() => {
      onClose();
    }, 1500);
  };

  return createPortal(
    <div
      className="modal-backdrop-premium"
      onClick={onClose}
    >
      <FocusTrap>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="device-flow-modal-title"
          className={clsx(
            'modal-panel-premium modal-md',
            'max-w-md w-full mx-4'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-surface-700">
            <div className="flex items-center gap-3">
              <GitHubIcon className="w-6 h-6 text-surface-300" />
              <h2
                id="device-flow-modal-title"
                className="text-lg font-semibold text-surface-100"
              >
                Connect to GitHub
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6">
            <DeviceFlowLogin
              onAuthSuccess={handleAuthSuccess}
              onAuthError={onAuthError}
              onCancel={onClose}
              autoOpenBrowser={true}
            />
          </div>
        </div>
      </FocusTrap>
    </div>,
    document.body
  );
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

export default DeviceFlowLoginModal;
