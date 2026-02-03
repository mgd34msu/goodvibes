// ============================================================================
// SETTINGS VIEW - SHARED COMPONENTS
// ============================================================================

import { useState, useRef, useEffect } from 'react';
import { clsx } from 'clsx';

// ============================================================================
// SETTINGS SECTION
// ============================================================================

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
  /** When true, section is collapsible with expand/collapse toggle */
  collapsible?: boolean;
  /** Initial expanded state when collapsible (default: false) */
  defaultExpanded?: boolean;
  /** Optional compact preview shown when collapsed */
  collapsedPreview?: React.ReactNode;
}

export function SettingsSection({
  title,
  children,
  collapsible = false,
  defaultExpanded = false,
  collapsedPreview,
}: SettingsSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const sectionRef = useRef<HTMLDivElement>(null);

  // Close on click outside when expanded
  useEffect(() => {
    if (!collapsible || !isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (sectionRef.current && !sectionRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [collapsible, isExpanded]);

  const handleToggle = () => {
    if (collapsible) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div ref={sectionRef} className="space-y-3">
      <button
        type="button"
        onClick={handleToggle}
        disabled={!collapsible}
        className={clsx(
          'flex items-center gap-2 w-full text-left',
          collapsible && 'cursor-pointer hover:opacity-80 transition-opacity'
        )}
      >
        {collapsible && (
          <svg
            className={clsx(
              'w-4 h-4 text-surface-400 transition-transform duration-200',
              isExpanded && 'rotate-90'
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        )}
        <h2 className="text-xs font-semibold text-surface-400 uppercase tracking-wider">{title}</h2>
        <div className="flex-1 h-px bg-gradient-to-r from-surface-700 to-transparent" />
      </button>
      {collapsible && !isExpanded ? (
        <button
          type="button"
          onClick={handleToggle}
          className="w-full text-left card-elevated rounded-xl overflow-hidden cursor-pointer hover:bg-surface-800/50 transition-colors"
        >
          {collapsedPreview}
        </button>
      ) : (
        <div className="card-elevated rounded-xl divide-y divide-surface-700/50 overflow-hidden">
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SETTING ROW
// ============================================================================

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

export function SettingRow({ label, description, children }: SettingRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-5 py-4 hover:bg-surface-800/30 transition-colors">
      <div className="flex-1 min-w-0 pr-4">
        <div className="text-sm font-medium text-surface-100">{label}</div>
        {description && (
          <div className="text-xs text-surface-500 mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// ============================================================================
// TOGGLE SWITCH
// ============================================================================

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function ToggleSwitch({ checked, onChange, disabled = false }: ToggleSwitchProps): React.JSX.Element {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      onChange(!checked);
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={handleClick}
      disabled={disabled}
      className={clsx(
        'relative inline-flex flex-shrink-0 w-11 h-6 rounded-full transition-all duration-200',
        !disabled && 'cursor-pointer',
        disabled && 'opacity-50 cursor-not-allowed',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-800',
        checked ? 'bg-primary-500 shadow-md shadow-primary-500/30' : 'bg-surface-600'
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200',
          checked ? 'translate-x-5 shadow-md' : 'translate-x-0.5'
        )}
      />
    </button>
  );
}

// ============================================================================
// SHORTCUT ROW
// ============================================================================

interface ShortcutRowProps {
  action: string;
  shortcut: string;
}

export function ShortcutRow({ action, shortcut }: ShortcutRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-2.5 px-1 hover:bg-surface-800/20 rounded-lg transition-colors -mx-1">
      <span className="text-sm text-surface-300">{action}</span>
      <kbd className="px-2.5 py-1 text-xs font-medium bg-surface-800 border border-surface-700 rounded-md text-surface-300 shadow-sm">{shortcut}</kbd>
    </div>
  );
}
