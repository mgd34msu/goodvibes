// ============================================================================
// GITHUB OAUTH CONFIG MODAL
// Modal for configuring custom GitHub OAuth App credentials
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X, Copy, Check, Info, Shield, Key } from 'lucide-react';
import { FocusTrap } from '../common/FocusTrap';
import { useGitHubOAuthConfig } from '../../hooks/useGitHubOAuthConfig';
import { toast } from '../../stores/toastStore';

// ============================================================================
// TYPES
// ============================================================================

interface GitHubOAuthConfigModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback when configuration is saved successfully */
  onSave?: () => void;
}

type AuthFlowType = 'device' | 'authorization_code';

// ============================================================================
// CONSTANTS
// ============================================================================

const CALLBACK_URL = 'goodvibes://oauth/callback';

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function GitHubOAuthConfigModal({
  isOpen,
  onClose,
  onSave,
}: GitHubOAuthConfigModalProps) {
  const { oauthStatus, isLoading, setCustomCredentials, clearCustomCredentials, refresh } = useGitHubOAuthConfig();

  // Form state
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [authFlow, setAuthFlow] = useState<AuthFlowType>('device');
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Validation state
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({});

  // Initialize form when status loads or modal opens
  useEffect(() => {
    if (isOpen && oauthStatus) {
      if (oauthStatus.source === 'custom' && oauthStatus.clientId) {
        setClientId(oauthStatus.clientId);
        setAuthFlow(oauthStatus.useDeviceFlow ? 'device' : 'authorization_code');
        // Never pre-fill client secret for security
        setClientSecret('');
      } else {
        setClientId('');
        setClientSecret('');
        setAuthFlow('device');
      }
      setErrors({});
    }
  }, [isOpen, oauthStatus]);

  // Refresh status when modal opens
  useEffect(() => {
    if (isOpen) {
      refresh();
    }
  }, [isOpen, refresh]);

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

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const validate = useCallback((): boolean => {
    const newErrors: { clientId?: string; clientSecret?: string } = {};

    if (!clientId.trim()) {
      newErrors.clientId = 'Client ID is required';
    }

    if (authFlow === 'authorization_code' && !clientSecret.trim()) {
      newErrors.clientSecret = 'Client Secret is required for Authorization Code flow';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [clientId, clientSecret, authFlow]);

  const handleSave = async () => {
    if (!validate()) return;

    setIsSaving(true);
    try {
      const success = await setCustomCredentials({
        clientId: clientId.trim(),
        clientSecret: authFlow === 'authorization_code' ? clientSecret.trim() : null,
        useDeviceFlow: authFlow === 'device',
      });

      if (success) {
        toast.success('Custom OAuth credentials saved');
        onSave?.();
        onClose();
      } else {
        toast.error('Failed to save credentials');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setIsClearing(true);
    try {
      const success = await clearCustomCredentials();

      if (success) {
        toast.success('Custom OAuth credentials cleared');
        setClientId('');
        setClientSecret('');
        setAuthFlow('device');
        onSave?.();
      } else {
        toast.error('Failed to clear credentials');
      }
    } finally {
      setIsClearing(false);
    }
  };

  const handleCopyCallback = async () => {
    try {
      await navigator.clipboard.writeText(CALLBACK_URL);
      setCopied(true);
      toast.success('Callback URL copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (!isOpen) return null;

  const isCustomConfigured = oauthStatus?.source === 'custom';

  return createPortal(
    <div
      className="modal-backdrop-premium"
      onClick={onClose}
    >
      <FocusTrap>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="oauth-config-modal-title"
          className={clsx(
            'modal-panel-premium modal-lg',
            'max-w-lg w-full mx-4'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-surface-700">
            <div className="flex items-center gap-3">
              <Key className="w-6 h-6 text-surface-300" />
              <h2
                id="oauth-config-modal-title"
                className="text-lg font-semibold text-surface-100"
              >
                Custom OAuth App
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
          <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
            {/* Current Status */}
            {oauthStatus && (
              <div className={clsx(
                'px-4 py-3 rounded-lg text-sm',
                oauthStatus.source === 'custom'
                  ? 'bg-primary-500/10 border border-primary-500/20'
                  : 'bg-surface-800 border border-surface-700'
              )}>
                <div className="flex items-center gap-2">
                  <span className={clsx(
                    'w-2 h-2 rounded-full',
                    oauthStatus.source === 'custom' ? 'bg-primary-400' : 'bg-surface-500'
                  )} />
                  <span className="text-surface-300">
                    Current: <span className="text-surface-100 font-medium">
                      {oauthStatus.source === 'custom' ? 'Custom OAuth App' :
                       oauthStatus.source === 'environment' ? 'Environment Variables' :
                       'Built-in App'}
                    </span>
                  </span>
                </div>
              </div>
            )}

            {/* Instructions */}
            <div className="bg-surface-800/50 rounded-lg p-4 space-y-3">
              <div className="flex items-start gap-2 text-sm text-surface-400">
                <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary-400" />
                <div className="space-y-2">
                  <p>
                    Create a GitHub OAuth App at{' '}
                    <a
                      href="https://github.com/settings/developers"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-400 hover:text-primary-300 underline"
                    >
                      github.com/settings/developers
                    </a>
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-surface-500">
                    <li>Application name: Any name you prefer</li>
                    <li>Homepage URL: Any valid URL</li>
                    <li>Authorization callback URL: Use the URL below</li>
                  </ul>
                </div>
              </div>

              {/* Callback URL */}
              <div className="mt-3">
                <label className="block text-xs font-medium text-surface-400 mb-1.5">
                  Authorization callback URL
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-surface-900 rounded-lg text-sm font-mono text-surface-200 border border-surface-700">
                    {CALLBACK_URL}
                  </code>
                  <button
                    onClick={handleCopyCallback}
                    className="p-2 rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 transition-colors"
                    title="Copy to clipboard"
                  >
                    {copied ? <Check className="w-4 h-4 text-success-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Auth Flow Toggle */}
            <div>
              <label className="block text-sm font-medium text-surface-200 mb-2">
                Authentication Flow
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setAuthFlow('device')}
                  className={clsx(
                    'p-3 rounded-lg border text-left transition-all',
                    authFlow === 'device'
                      ? 'border-primary-500 bg-primary-500/10'
                      : 'border-surface-700 bg-surface-800 hover:border-surface-600'
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className={clsx('w-4 h-4', authFlow === 'device' ? 'text-primary-400' : 'text-surface-400')} />
                    <span className={clsx('text-sm font-medium', authFlow === 'device' ? 'text-primary-300' : 'text-surface-200')}>
                      Device Flow
                    </span>
                  </div>
                  <p className="text-xs text-surface-500">
                    Recommended. More secure, no client secret needed.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setAuthFlow('authorization_code')}
                  className={clsx(
                    'p-3 rounded-lg border text-left transition-all',
                    authFlow === 'authorization_code'
                      ? 'border-primary-500 bg-primary-500/10'
                      : 'border-surface-700 bg-surface-800 hover:border-surface-600'
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Key className={clsx('w-4 h-4', authFlow === 'authorization_code' ? 'text-primary-400' : 'text-surface-400')} />
                    <span className={clsx('text-sm font-medium', authFlow === 'authorization_code' ? 'text-primary-300' : 'text-surface-200')}>
                      Authorization Code
                    </span>
                  </div>
                  <p className="text-xs text-surface-500">
                    Traditional OAuth. Requires client secret.
                  </p>
                </button>
              </div>
            </div>

            {/* Client ID */}
            <div>
              <label htmlFor="client-id" className="block text-sm font-medium text-surface-200 mb-1.5">
                Client ID <span className="text-error-400">*</span>
              </label>
              <input
                id="client-id"
                type="text"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  if (errors.clientId) setErrors((prev) => ({ ...prev, clientId: undefined }));
                }}
                placeholder="Ov23li..."
                className={clsx(
                  'w-full px-3 py-2 bg-surface-800 border rounded-lg text-sm text-surface-100',
                  'placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/50',
                  errors.clientId ? 'border-error-500' : 'border-surface-700'
                )}
              />
              {errors.clientId && (
                <p className="mt-1 text-xs text-error-400">{errors.clientId}</p>
              )}
            </div>

            {/* Client Secret (only shown for authorization code flow) */}
            {authFlow === 'authorization_code' && (
              <div>
                <label htmlFor="client-secret" className="block text-sm font-medium text-surface-200 mb-1.5">
                  Client Secret <span className="text-error-400">*</span>
                </label>
                <input
                  id="client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => {
                    setClientSecret(e.target.value);
                    if (errors.clientSecret) setErrors((prev) => ({ ...prev, clientSecret: undefined }));
                  }}
                  placeholder="Enter client secret"
                  className={clsx(
                    'w-full px-3 py-2 bg-surface-800 border rounded-lg text-sm text-surface-100',
                    'placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/50',
                    errors.clientSecret ? 'border-error-500' : 'border-surface-700'
                  )}
                />
                {errors.clientSecret && (
                  <p className="mt-1 text-xs text-error-400">{errors.clientSecret}</p>
                )}
                <p className="mt-1 text-xs text-surface-500">
                  Stored securely and never exposed to the UI.
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-surface-700 bg-surface-850">
            <div>
              {isCustomConfigured && (
                <button
                  onClick={handleClear}
                  disabled={isClearing || isLoading}
                  className="btn btn-ghost btn-sm text-error-400 hover:text-error-300 hover:bg-error-500/10"
                >
                  {isClearing ? 'Clearing...' : 'Clear Custom Credentials'}
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="btn btn-secondary btn-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || isLoading}
                className="btn btn-primary btn-sm"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </FocusTrap>
    </div>,
    document.body
  );
}

export default GitHubOAuthConfigModal;
