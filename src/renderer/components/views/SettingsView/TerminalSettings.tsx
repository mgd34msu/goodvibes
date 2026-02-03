// ============================================================================
// TERMINAL SETTINGS SECTION
// ============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { AppSettings } from '../../../../shared/types';
import { SettingsSection, SettingRow } from './components';
import { FocusTrap } from '../../common/FocusTrap';

// ============================================================================
// CONSTANTS
// ============================================================================

const WINDOWS_DEFAULT_SHELLS = [
  { value: 'cmd.exe', label: 'Command Prompt (cmd.exe)' },
  { value: 'powershell.exe', label: 'Windows PowerShell (powershell.exe)' },
  { value: 'pwsh.exe', label: 'PowerShell Core (pwsh.exe)' },
];

const UNIX_DEFAULT_SHELLS = [
  { value: '/bin/bash', label: 'Bash (/bin/bash)' },
  { value: '/bin/zsh', label: 'Zsh (/bin/zsh)' },
  { value: '/bin/sh', label: 'Bourne Shell (/bin/sh)' },
  { value: '/bin/fish', label: 'Fish (/bin/fish)' },
];

const ADD_CUSTOM_VALUE = '__add_custom__';

// ============================================================================
// CUSTOM SHELL MODAL
// ============================================================================

interface CustomShellModalProps {
  isOpen: boolean;
  onConfirm: (shellPath: string) => void;
  onCancel: () => void;
  isWindows: boolean;
}

function CustomShellModal({ isOpen, onConfirm, onCancel, isWindows }: CustomShellModalProps) {
  const [shellPath, setShellPath] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setShellPath('');
      // Focus the input after a brief delay to ensure modal is rendered
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      onCancel();
    } else if (e.key === 'Enter' && shellPath.trim()) {
      onConfirm(shellPath.trim());
    }
  }, [isOpen, onCancel, onConfirm, shellPath]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleConfirm = () => {
    const trimmed = shellPath.trim();
    if (trimmed) {
      onConfirm(trimmed);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Modal */}
      <FocusTrap>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="custom-shell-modal-title"
          className="relative z-10 w-full max-w-md mx-4 bg-surface-800 rounded-lg shadow-xl"
        >
          <div className="p-6">
            {/* Title */}
            <h2
              id="custom-shell-modal-title"
              className="text-lg font-semibold text-surface-100"
            >
              Add Custom Shell
            </h2>

            {/* Description */}
            <p className="mt-2 text-sm text-surface-400">
              Enter the full path to your shell executable.
            </p>

            {/* Input */}
            <input
              ref={inputRef}
              type="text"
              value={shellPath}
              onChange={(e) => setShellPath(e.target.value)}
              placeholder={isWindows ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/usr/local/bin/fish'}
              className="input w-full mt-4"
            />

            {/* Actions */}
            <div className="mt-6 flex gap-3 justify-end">
              <button
                onClick={onCancel}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={!shellPath.trim()}
                className="btn btn-primary"
              >
                Add Shell
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
// TERMINAL SETTINGS COMPONENT
// ============================================================================

interface TextEditorInfo {
  name: string;
  command: string;
  available: boolean;
}

interface TerminalSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function TerminalSettings({ settings, onChange }: TerminalSettingsProps): React.JSX.Element {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [platform, setPlatform] = useState<NodeJS.Platform>('win32');
  const [availableEditors, setAvailableEditors] = useState<TextEditorInfo[]>([]);

  useEffect(() => {
    // Get the platform from preload
    const detectedPlatform = window.goodvibes.getPlatform();
    setPlatform(detectedPlatform);

    // Get available text editors
    window.goodvibes.getAvailableEditors().then(editors => {
      setAvailableEditors(editors);
    }).catch(() => {
      // Ignore errors
    });
  }, []);

  const isWindows = platform === 'win32';

  // Get the default shells based on platform
  const defaultShells = isWindows ? WINDOWS_DEFAULT_SHELLS : UNIX_DEFAULT_SHELLS;

  // Combine default shells with custom shells
  const customShells = settings.customShells || [];
  const allShells = [
    ...defaultShells,
    ...customShells.map((shell) => ({
      value: shell,
      label: `${shell} (custom)`,
    })),
  ];

  // Handle shell selection change
  const handleShellChange = (value: string) => {
    if (value === ADD_CUSTOM_VALUE) {
      setIsModalOpen(true);
    } else if (value === '') {
      // "System Default" selected
      onChange('preferredShell', null);
    } else {
      onChange('preferredShell', value);
    }
  };

  // Handle adding a custom shell
  const handleAddCustomShell = (shellPath: string) => {
    // Add to custom shells list if not already there
    const currentCustomShells = settings.customShells || [];
    const allExistingShells = [
      ...defaultShells.map((s) => s.value),
      ...currentCustomShells,
    ];

    if (!allExistingShells.includes(shellPath)) {
      onChange('customShells', [...currentCustomShells, shellPath]);
    }

    // Set as the preferred shell
    onChange('preferredShell', shellPath);
    setIsModalOpen(false);
  };

  const handleCancelModal = () => {
    setIsModalOpen(false);
  };

  // Get the platform-specific description
  const shellDescription = isWindows
    ? 'Shell used for new terminal windows (uses COMSPEC if not set)'
    : 'Shell used for new terminal windows (uses SHELL if not set)';

  // Handler for text editor selection change
  const handleEditorChange = (value: string) => {
    if (value === '') {
      // "Auto-detect" selected
      onChange('preferredTextEditor', null);
    } else {
      onChange('preferredTextEditor', value);
    }
  };

  // Get the available editors for the dropdown
  const editorOptions = availableEditors.filter(e => e.available);

  return (
    <>
      <SettingsSection title="Terminal">
        <SettingRow
          label="Default Shell"
          description={shellDescription}
        >
          <select
            value={settings.preferredShell || ''}
            onChange={(e) => handleShellChange(e.target.value)}
            className="select w-64"
          >
            <option value="">System Default</option>
            {allShells.map((shell) => (
              <option key={shell.value} value={shell.value}>
                {shell.label}
              </option>
            ))}
            <option value={ADD_CUSTOM_VALUE}>+ Add custom...</option>
          </select>
        </SettingRow>

        <SettingRow
          label="Default Text Editor"
          description="Text editor to use when opening a text editor from the menu"
        >
          <select
            value={settings.preferredTextEditor || ''}
            onChange={(e) => handleEditorChange(e.target.value)}
            className="select w-64"
          >
            <option value="">Auto-detect (first available)</option>
            {editorOptions.map((editor) => (
              <option key={editor.command} value={editor.command}>
                {editor.name} ({editor.command})
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsSection>

      <CustomShellModal
        isOpen={isModalOpen}
        onConfirm={handleAddCustomShell}
        onCancel={handleCancelModal}
        isWindows={isWindows}
      />
    </>
  );
}
