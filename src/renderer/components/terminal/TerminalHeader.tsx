// ============================================================================
// TERMINAL HEADER - Premium tab bar and controls for terminal view
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
    <div className="panel-header flex items-center gap-4 px-4 py-3">
      {/* Terminal Tabs */}
      <div
        className="flex items-center gap-2 flex-1 overflow-x-auto scrollbar-hidden"
        role="tablist"
        aria-label="Terminal tabs"
      >
        {terminals.map((terminal) => {
          const isActive = terminal.id === activeTerminalId;
          return (
            <div
              key={terminal.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              onClick={() => setActiveTerminal(terminal.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveTerminal(terminal.id);
                }
              }}
              className={clsx(
                'tab-premium flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap group w-fit cursor-pointer',
                isActive && 'tab-premium-active text-white',
                !isActive && 'text-surface-400'
              )}
            >
              {/* Status Indicator */}
              <span
                className={clsx(
                  'w-2 h-2 rounded-full flex-shrink-0 transition-all duration-200',
                  terminal.isPreview && 'bg-accent-400 shadow-[0_0_8px_rgba(139,92,246,0.5)]',
                  terminal.isPlainTerminal && 'bg-warning-400 shadow-[0_0_8px_rgba(245,158,11,0.5)]',
                  !terminal.isPreview && !terminal.isPlainTerminal && 'bg-success-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                )}
                aria-hidden="true"
                title={terminal.isPreview ? 'Preview' : terminal.isPlainTerminal ? 'Terminal' : 'Claude Session'}
              />
              <span className="truncate max-w-[160px]">{terminal.name}</span>
              {/* Close Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(terminal.id);
                }}
                className={clsx(
                  'opacity-0 group-hover:opacity-100 p-1 rounded-md transition-all duration-150 ml-0.5',
                  isActive
                    ? 'hover:bg-white/20 text-white/70 hover:text-white'
                    : 'hover:bg-surface-700 text-surface-500 hover:text-surface-200'
                )}
                aria-label={`Close terminal ${terminal.name}`}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {/* New Dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          className={clsx(
            'btn-premium-ghost flex items-center gap-2 px-3.5 py-2 text-surface-300 hover:text-white',
            isDropdownOpen && 'border-surface-600 bg-surface-800/50'
          )}
          title="New... (Ctrl+N)"
          aria-label="New"
          aria-expanded={isDropdownOpen}
          aria-haspopup="menu"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-sm font-medium">New</span>
          <svg
            className={clsx('w-3 h-3 transition-transform duration-200', isDropdownOpen && 'rotate-180')}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Premium Dropdown Menu */}
        {isDropdownOpen && (
          <div className="dropdown-premium absolute right-0 top-full mt-2 w-64 z-50" role="menu">
            <div className="p-1">
              <button
                onClick={handleNewClaudeSession}
                className="dropdown-item-premium flex items-center gap-3 w-full px-4 py-3 text-left rounded-lg"
                role="menuitem"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br from-primary-500/20 to-primary-600/10 flex items-center justify-center">
                  <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <div className="font-medium text-surface-100">Claude Code Session</div>
                  <div className="text-xs text-surface-500">Start a new Claude CLI session</div>
                </div>
              </button>

              <div className="divider-gradient my-1 mx-3" />

              <button
                onClick={handleNewTerminal}
                className="dropdown-item-premium flex items-center gap-3 w-full px-4 py-3 text-left rounded-lg"
                role="menuitem"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br from-success-500/20 to-success-600/10 flex items-center justify-center">
                  <svg className="w-5 h-5 text-success-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <div className="font-medium text-surface-100">Terminal Window</div>
                  <div className="text-xs text-surface-500">Open a plain shell terminal</div>
                </div>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Git Toggle Button */}
      {hasActiveSession && (
        <button
          onClick={onToggleGitPanel}
          className={clsx(
            'btn-premium-ghost p-2.5 mr-1 transition-all duration-200',
            showGitPanel
              ? 'text-primary-400 bg-primary-500/15 border-primary-500/30 shadow-[0_0_12px_rgba(99,102,241,0.15)]'
              : 'text-surface-400 hover:text-surface-200'
          )}
          title={showGitPanel ? 'Hide Git Panel' : 'Show Git Panel'}
          aria-label={showGitPanel ? 'Hide Git Panel' : 'Show Git Panel'}
          aria-pressed={showGitPanel}
        >
          <svg className={clsx('w-4 h-4 transition-all duration-200', showGitPanel && 'icon-hover-glow')} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18V6M6 6a3 3 0 100-6 3 3 0 000 6zm12 12a3 3 0 100-6 3 3 0 000 6zm0 0V9a3 3 0 00-3-3H9" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default TerminalHeader;
