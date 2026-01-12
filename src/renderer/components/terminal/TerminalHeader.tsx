// ============================================================================
// TERMINAL HEADER - Tab bar and controls for terminal view
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAppStore } from '../../stores/appStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { TerminalHeaderProps } from './types';

// ============================================================================
// COMPONENT
// ============================================================================

export function TerminalHeader({ showGitPanel, onToggleGitPanel, hasActiveSession }: TerminalHeaderProps) {
  const terminalsMap = useTerminalStore((s) => s.terminals);
  const terminals = useMemo(() => Array.from(terminalsMap.values()), [terminalsMap]);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const createPlainTerminal = useTerminalStore((s) => s.createPlainTerminal);
  const openFolderPicker = useAppStore((s) => s.openFolderPicker);
  const projectsRoot = useSettingsStore((s) => s.settings.projectsRoot);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNewClaudeSession = useCallback(() => {
    setIsDropdownOpen(false);
    openFolderPicker();
  }, [openFolderPicker]);

  const handleNewTerminal = useCallback(async () => {
    setIsDropdownOpen(false);
    // Use projectsRoot setting if defined, or fall back to most recent project
    let cwd = projectsRoot;
    if (!cwd) {
      const recentProjects = await window.goodvibes.getRecentProjects();
      if (recentProjects.length > 0) {
        cwd = recentProjects[0].path;
      }
    }
    if (cwd) {
      await createPlainTerminal(cwd);
    }
  }, [createPlainTerminal, projectsRoot]);

  return (
    <div className="flex items-center gap-4 px-3 py-3 bg-surface-900 border-b border-surface-800">
      {/* Terminal Tabs */}
      <div
        className="flex items-center gap-2 flex-1 overflow-x-auto scrollbar-hidden"
        role="tablist"
        aria-label="Terminal tabs"
      >
        {terminals.map((terminal) => (
          <div
            key={terminal.id}
            role="tab"
            tabIndex={0}
            aria-selected={terminal.id === activeTerminalId}
            onClick={() => setActiveTerminal(terminal.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveTerminal(terminal.id);
              }
            }}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors group w-fit cursor-pointer',
              terminal.id === activeTerminalId
                ? 'bg-primary-600 text-white shadow-sm'
                : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200'
            )}
          >
            <span className={clsx(
                'w-2.5 h-2.5 rounded-full flex-shrink-0',
                terminal.isPreview ? 'bg-accent-500' : terminal.isPlainTerminal ? 'bg-warning-500' : 'bg-success-500'
              )}
              aria-hidden="true"
              title={terminal.isPreview ? 'Preview' : terminal.isPlainTerminal ? 'Terminal' : 'Claude Session'}
            />
            <span className="truncate">{terminal.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(terminal.id);
              }}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface-600 transition-opacity ml-1"
              aria-label={`Close terminal ${terminal.name}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* New Dropdown - positioned BEFORE git icon */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-surface-200 bg-surface-800 hover:text-white hover:bg-surface-700 transition-colors border border-surface-700"
          title="New... (Ctrl+N)"
          aria-label="New"
          aria-expanded={isDropdownOpen}
          aria-haspopup="menu"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-sm font-medium">New...</span>
          <svg className={clsx('w-3 h-3 transition-transform', isDropdownOpen && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Dropdown Menu */}
        {isDropdownOpen && (
          <div className="absolute right-0 top-full mt-1 w-56 bg-surface-800 border border-surface-700 rounded-lg shadow-lg z-50" role="menu">
            <button
              onClick={handleNewClaudeSession}
              className="flex items-center gap-3 w-full px-4 py-3 text-left text-surface-200 hover:bg-surface-700 hover:text-white transition-colors rounded-t-lg"
              role="menuitem"
            >
              <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <div>
                <div className="font-medium">Claude Code Session</div>
                <div className="text-xs text-surface-400">Start a new Claude CLI session</div>
              </div>
            </button>
            <button
              onClick={handleNewTerminal}
              className="flex items-center gap-3 w-full px-4 py-3 text-left text-surface-200 hover:bg-surface-700 hover:text-white transition-colors rounded-b-lg border-t border-surface-700"
              role="menuitem"
            >
              <svg className="w-5 h-5 text-success-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <div>
                <div className="font-medium">Terminal Window</div>
                <div className="text-xs text-surface-400">Open a plain shell terminal</div>
              </div>
            </button>
          </div>
        )}
      </div>

      {/* Git Toggle Button - Only show when there's an active CLI session */}
      {hasActiveSession && (
        <button
          onClick={onToggleGitPanel}
          className={clsx(
            'p-2 mr-2 rounded-lg transition-colors',
            showGitPanel
              ? 'text-primary-400 bg-primary-500/20 hover:bg-primary-500/30'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'
          )}
          title={showGitPanel ? 'Hide Git Panel' : 'Show Git Panel'}
          aria-label={showGitPanel ? 'Hide Git Panel' : 'Show Git Panel'}
          aria-pressed={showGitPanel}
        >
          {/* Git Branch Icon */}
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18V6M6 6a3 3 0 100-6 3 3 0 000 6zm12 12a3 3 0 100-6 3 3 0 000 6zm0 0V9a3 3 0 00-3-3H9" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default TerminalHeader;
