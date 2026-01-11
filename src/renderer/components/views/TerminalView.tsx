// ============================================================================
// TERMINAL VIEW COMPONENT
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAppStore } from '../../stores/appStore';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { TERMINAL_THEMES } from '../../../shared/constants';
import { useSettingsStore } from '../../stores/settingsStore';
import { SessionPreviewView } from '../preview/SessionPreviewView';
import { GitHubPanel } from '../github';
import type { GitFileChange, GitBranchInfo, GitCommitInfo, GitCommitDetail, GitTag, GitBlameLine, GitFileHistoryEntry, GitConflictFile, GitReflogEntry } from '../../../shared/types';
import '@xterm/xterm/css/xterm.css';
import appIcon from '../../assets/icon.png';

export default function TerminalView() {
  const terminalsMap = useTerminalStore((s) => s.terminals);
  const terminals = useMemo(() => Array.from(terminalsMap.values()), [terminalsMap]);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const zoomLevel = useTerminalStore((s) => s.zoomLevel);
  const createPlainTerminal = useTerminalStore((s) => s.createPlainTerminal);
  const gitPanelPosition = useSettingsStore((s) => s.settings.gitPanelPosition);

  const openFolderPicker = useAppStore((s) => s.openFolderPicker);

  // Default to showing git panel when there's an active terminal session
  const [showGitPanel, setShowGitPanel] = useState(true);

  const hasTerminals = terminals.length > 0;
  const activeTerminal = activeTerminalId ? terminalsMap.get(activeTerminalId) : undefined;
  const hasActiveSession = hasTerminals && activeTerminal && !activeTerminal.isPreview;

  // Handler for opening a plain terminal in project root or most recent project
  const projectsRoot = useSettingsStore((s) => s.settings.projectsRoot);
  const handleOpenTerminal = useCallback(async () => {
    // Use projectsRoot setting if defined, or fall back to most recent project
    let cwd = projectsRoot;
    if (!cwd) {
      const recentProjects = await window.clausitron.getRecentProjects();
      if (recentProjects.length > 0) {
        cwd = recentProjects[0].path;
      }
    }
    if (cwd) {
      await createPlainTerminal(cwd);
    }
  }, [createPlainTerminal, projectsRoot]);

  return (
    <div className="flex flex-col h-full">
      {/* Terminal Header */}
      <TerminalHeader
        showGitPanel={showGitPanel}
        onToggleGitPanel={() => setShowGitPanel(!showGitPanel)}
        hasActiveSession={hasActiveSession}
      />

      {/* Terminal Content */}
      <div className="flex-1 flex overflow-hidden">
        {hasTerminals ? (
          <>
            {/* Git Panel - Left Position */}
            {showGitPanel && hasActiveSession && gitPanelPosition === 'left' && activeTerminal?.cwd && (
              <GitPanel cwd={activeTerminal.cwd} position="left" />
            )}

            <div className="flex-1 relative bg-[#1a1a2e]">
              {terminals.map((terminal) => (
                <div
                  key={terminal.id}
                  className={clsx(
                    'absolute inset-0',
                    terminal.id === activeTerminalId ? 'block' : 'hidden'
                  )}
                >
                  {terminal.isPreview && terminal.previewSessionId ? (
                    <SessionPreviewView
                      sessionId={terminal.previewSessionId}
                      sessionName={terminal.name.replace('Preview: ', '')}
                    />
                  ) : (
                    <TerminalInstance
                      id={terminal.id}
                      zoomLevel={zoomLevel}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Git Panel - Right Position */}
            {showGitPanel && hasActiveSession && gitPanelPosition === 'right' && activeTerminal?.cwd && (
              <GitPanel cwd={activeTerminal.cwd} position="right" />
            )}
          </>
        ) : (
          <EmptyState onNewSession={openFolderPicker} onNewTerminal={handleOpenTerminal} />
        )}
      </div>

      {/* Terminal Footer */}
      <TerminalFooter />

      {/* Folder Picker Modal */}
      <FolderPickerModal />
    </div>
  );
}

// ============================================================================
// TERMINAL HEADER
// ============================================================================

interface TerminalHeaderProps {
  showGitPanel: boolean;
  onToggleGitPanel: () => void;
  hasActiveSession: boolean | undefined;
}

function TerminalHeader({ showGitPanel, onToggleGitPanel, hasActiveSession }: TerminalHeaderProps) {
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
      const recentProjects = await window.clausitron.getRecentProjects();
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

// ============================================================================
// TERMINAL INSTANCE
// ============================================================================

interface TerminalInstanceProps {
  id: number;
  zoomLevel: number;
}

function TerminalInstance({ id, zoomLevel }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const theme = useSettingsStore((s) => s.settings.theme);

  // Track if user has scrolled up (for showing scroll-to-bottom button)
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Copy selected text from terminal
  const copySelection = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const selection = terminal.getSelection();
    if (selection) {
      window.clausitron.clipboardWrite(selection);
    }
  }, []);

  // Paste text into terminal
  const pasteToTerminal = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const text = await window.clausitron.clipboardRead();
    if (text) {
      // Send the pasted text to the terminal PTY
      window.clausitron.terminalInput(id, text);
    }
  }, [id]);

  // Handle context menu
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    const terminal = terminalRef.current;
    if (!terminal) return;

    const hasSelection = terminal.hasSelection();
    const selectedText = hasSelection ? terminal.getSelection() : undefined;

    const action = await window.clausitron.showTerminalContextMenu({
      hasSelection,
      selectedText,
    });

    if (action === 'paste') {
      pasteToTerminal();
    } else if (action === 'clear') {
      terminal.clear();
    }
    // 'copy' action is handled by the main process directly
  }, [pasteToTerminal]);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new XTermTerminal({
      fontFamily: "'CaskaydiaMonoNerdFontMono', 'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: TERMINAL_THEMES[theme],
      allowProposedApi: true,
      // Prevent automatic scroll behavior that causes flickering
      scrollOnUserInput: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    // Handle terminal input
    terminal.onData((data) => {
      window.clausitron.terminalInput(id, data);
    });

    // Handle terminal resize
    terminal.onResize(({ cols, rows }) => {
      window.clausitron.terminalResize(id, cols, rows);
    });

    // Detect when user scrolls manually (debounced to avoid flicker during output)
    const viewportElement = containerRef.current?.querySelector('.xterm-viewport');
    const handleScroll = () => {
      const viewport = terminal.element?.querySelector('.xterm-viewport');
      if (!viewport) return;

      // Check if scrolled to bottom (with small tolerance for rounding)
      const isAtBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 5;

      // Debounce the scroll-up detection to avoid showing button during rapid output
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }

      if (!isAtBottom) {
        // User scrolled up - show button after a delay (if they stay scrolled up)
        scrollDebounceRef.current = setTimeout(() => {
          setIsUserScrolledUp(true);
        }, 150);
      } else {
        // At bottom - immediately hide the button
        setIsUserScrolledUp(false);
      }
    };

    if (viewportElement) {
      viewportElement.addEventListener('scroll', handleScroll);
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Initial resize
    const cols = terminal.cols;
    const rows = terminal.rows;
    window.clausitron.terminalResize(id, cols, rows);

    return () => {
      if (viewportElement) {
        viewportElement.removeEventListener('scroll', handleScroll);
      }
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [id]);

  // Handle keyboard shortcuts for copy/paste in terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Ctrl+C (copy) when there's a selection
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const terminal = terminalRef.current;
        if (terminal && terminal.hasSelection()) {
          e.preventDefault();
          e.stopPropagation();
          copySelection();
          return;
        }
        // If no selection, let Ctrl+C pass through as SIGINT
      }

      // Check for Ctrl+V (paste)
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        e.stopPropagation();
        pasteToTerminal();
        return;
      }

      // Check for Ctrl+Shift+C (copy - alternative)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        e.stopPropagation();
        copySelection();
        return;
      }

      // Check for Ctrl+Shift+V (paste - alternative)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        e.stopPropagation();
        pasteToTerminal();
        return;
      }
    };

    container.addEventListener('keydown', handleKeyDown, true);
    return () => {
      container.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [copySelection, pasteToTerminal]);

  // Handle terminal data from main process
  // Simple approach: write data, scroll to bottom. Always.
  // The scroll-to-bottom button uses debounce so it only shows when user scrolls up AFTER output stops.
  useEffect(() => {
    const handleData = (data: { id: number; data: string }) => {
      if (data.id === id && terminalRef.current) {
        const terminal = terminalRef.current;
        terminal.write(data.data);
        // Always scroll to bottom after write - simple and reliable
        terminal.scrollToBottom();
      }
    };

    const cleanup = window.clausitron.onTerminalData(handleData);
    return cleanup;
  }, [id]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      fitAddonRef.current?.fit();
    };

    const resizeObserver = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, []);

  // Handle zoom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = Math.round(14 * (zoomLevel / 100));
      fitAddonRef.current?.fit();
    }
  }, [zoomLevel]);

  // Handle theme change
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = TERMINAL_THEMES[theme];
    }
  }, [theme]);

  // Scroll to bottom handler for the button
  const handleScrollToBottom = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollToBottom();
      setIsUserScrolledUp(false);
    }
  }, []);

  return (
    <div className="relative h-full w-full" onContextMenu={handleContextMenu}>
      <div ref={containerRef} className="h-full w-full p-2" />
      {/* Scroll to bottom button - shown when user has scrolled up */}
      {isUserScrolledUp && (
        <button
          onClick={handleScrollToBottom}
          className="absolute bottom-4 right-4 p-2 bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-full shadow-lg transition-all duration-200 opacity-80 hover:opacity-100 z-10"
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================

function EmptyState({ onNewSession, onNewTerminal }: { onNewSession: () => void; onNewTerminal: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-surface-900">
      <div className="text-center max-w-lg mx-auto px-6">
        <img src={appIcon} alt="Clausitron" className="w-24 h-24 mx-auto mb-8" />
        <h2 className="text-3xl font-bold text-surface-100 mb-4">Welcome to Clausitron</h2>
        <p className="text-surface-400 text-base mb-10 leading-relaxed">
          Start a new Claude Code session to begin working on your project, or open a plain terminal.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <button
            onClick={onNewSession}
            className="flex items-center gap-4 px-6 py-4 bg-surface-800 border border-surface-700 rounded-xl hover:bg-surface-700 hover:border-surface-600 transition-colors text-left"
            aria-label="Start new Claude Code session"
          >
            <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-primary-500/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <div className="font-semibold text-surface-100">Claude Code Session</div>
              <div className="text-sm text-surface-400">Start a new Claude CLI session</div>
            </div>
          </button>
          <button
            onClick={onNewTerminal}
            className="flex items-center gap-4 px-6 py-4 bg-surface-800 border border-surface-700 rounded-xl hover:bg-surface-700 hover:border-surface-600 transition-colors text-left"
            aria-label="Open new terminal"
          >
            <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-success-500/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-success-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <div className="font-semibold text-surface-100">Terminal Window</div>
              <div className="text-sm text-surface-400">Open a plain shell terminal</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// TERMINAL FOOTER
// ============================================================================

function TerminalFooter() {
  const terminalsMap = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const activeTerminal = useMemo(() => activeTerminalId ? terminalsMap.get(activeTerminalId) : undefined, [terminalsMap, activeTerminalId]);
  const zoomLevel = useTerminalStore((s) => s.zoomLevel);
  const setZoomLevel = useTerminalStore((s) => s.setZoomLevel);

  return (
    <div className="terminal-footer">
      <div className="session-info">
        <span>{activeTerminal?.cwd || 'No folder selected'}</span>
      </div>

      <div className="zoom-controls">
        <button
          onClick={() => setZoomLevel(zoomLevel - 10)}
          className="zoom-btn"
          title="Zoom Out"
        >
          -
        </button>
        <span id="zoom-level">{zoomLevel}%</span>
        <button
          onClick={() => setZoomLevel(zoomLevel + 10)}
          className="zoom-btn"
          title="Zoom In"
        >
          +
        </button>
        <button
          onClick={() => setZoomLevel(100)}
          className="zoom-btn zoom-reset"
          title="Reset Zoom"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// GIT PANEL - Full-featured Source Control
// ============================================================================

interface GitPanelProps {
  cwd: string;
  position: 'left' | 'right';
}

interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

interface GitPanelState {
  isRepo: boolean;
  isLoading: boolean;
  error: string | null;
  branch: string;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  branches: Array<GitBranchInfo & { parentBranch?: string; commitsAhead?: number }>;
  commits: GitCommitInfo[];
  commitMessage: string;
  isCommitting: boolean;
  isPushing: boolean;
  isPulling: boolean;
  isFetching: boolean;
  isMerging: boolean;
  mergeInProgress: boolean;
  showBranchDropdown: boolean;
  showNewBranchInput: boolean;
  newBranchName: string;
  newBranchError: string | null;
  expandedSections: {
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    commits: boolean;
    stashes: boolean;
    tags: boolean;
    conflicts: boolean;
  };
  operationInProgress: string | null;
  // Commit detail view
  selectedCommit: GitCommitDetail | null;
  showCommitDetail: boolean;
  isLoadingCommit: boolean;
  // Diff view
  showDiffModal: boolean;
  diffFile: string | null;
  diffContent: string | null;
  diffIsStaged: boolean;
  diffCommit: string | null;
  isLoadingDiff: boolean;
  // Branch checkout confirmation modal
  showCheckoutConfirmModal: boolean;
  pendingCheckoutBranch: string | null;
  // Merge modal
  showMergeModal: boolean;
  mergeBranch: string | null;
  mergeOptions: { noFf: boolean; squash: boolean };
  // Stash
  stashes: GitStashEntry[];
  showStashModal: boolean;
  stashMessage: string;
  // Commit amend
  amendMode: boolean;
  // Cherry-pick
  cherryPickInProgress: boolean;
  // Rebase
  rebaseInProgress: boolean;
  showRebaseModal: boolean;
  rebaseBranch: string | null;
  // Tags
  tags: GitTag[];
  showTagModal: boolean;
  newTagName: string;
  newTagMessage: string;
  newTagCommit: string;
  // Conflict resolution
  conflictFiles: GitConflictFile[];
  // File history
  showFileHistoryModal: boolean;
  fileHistoryFile: string | null;
  fileHistoryCommits: GitFileHistoryEntry[];
  isLoadingFileHistory: boolean;
  // Git blame
  showBlameModal: boolean;
  blameFile: string | null;
  blameLines: GitBlameLine[];
  isLoadingBlame: boolean;
  // Reflog
  showReflogModal: boolean;
  reflogEntries: GitReflogEntry[];
  isLoadingReflog: boolean;
  // Branch deletion
  showDeleteBranchModal: boolean;
  branchToDelete: string | null;
  deleteBranchForce: boolean;
  // Conventional commits
  conventionalPrefixes: string[];
  showConventionalDropdown: boolean;
}

function GitPanel({ cwd, position }: GitPanelProps) {
  const gitAutoRefresh = useSettingsStore((s) => s.settings.gitAutoRefresh);
  const githubEnabled = useSettingsStore((s) => s.settings.githubEnabled);
  const githubShowInGitPanel = useSettingsStore((s) => s.settings.githubShowInGitPanel);

  const [state, setState] = useState<GitPanelState>({
    isRepo: false,
    isLoading: true,
    error: null,
    branch: '',
    ahead: 0,
    behind: 0,
    hasRemote: false,
    hasUpstream: false,
    staged: [],
    unstaged: [],
    untracked: [],
    branches: [],
    commits: [],
    commitMessage: '',
    isCommitting: false,
    isPushing: false,
    isPulling: false,
    isFetching: false,
    isMerging: false,
    mergeInProgress: false,
    showBranchDropdown: false,
    showNewBranchInput: false,
    newBranchName: '',
    newBranchError: null,
    expandedSections: {
      staged: true,
      unstaged: true,
      untracked: true,
      commits: true,
      stashes: false,
      tags: false,
      conflicts: true,
    },
    operationInProgress: null,
    // Commit detail view
    selectedCommit: null,
    showCommitDetail: false,
    isLoadingCommit: false,
    // Diff view
    showDiffModal: false,
    diffFile: null,
    diffContent: null,
    diffIsStaged: false,
    diffCommit: null,
    isLoadingDiff: false,
    // Branch checkout confirmation modal
    showCheckoutConfirmModal: false,
    pendingCheckoutBranch: null,
    // Merge modal
    showMergeModal: false,
    mergeBranch: null,
    mergeOptions: { noFf: false, squash: false },
    // Stash
    stashes: [],
    showStashModal: false,
    stashMessage: '',
    // Commit amend
    amendMode: false,
    // Cherry-pick
    cherryPickInProgress: false,
    // Rebase
    rebaseInProgress: false,
    showRebaseModal: false,
    rebaseBranch: null,
    // Tags
    tags: [],
    showTagModal: false,
    newTagName: '',
    newTagMessage: '',
    newTagCommit: '',
    // Conflict resolution
    conflictFiles: [],
    // File history
    showFileHistoryModal: false,
    fileHistoryFile: null,
    fileHistoryCommits: [],
    isLoadingFileHistory: false,
    // Git blame
    showBlameModal: false,
    blameFile: null,
    blameLines: [],
    isLoadingBlame: false,
    // Reflog
    showReflogModal: false,
    reflogEntries: [],
    isLoadingReflog: false,
    // Branch deletion
    showDeleteBranchModal: false,
    branchToDelete: null,
    deleteBranchForce: false,
    // Conventional commits
    conventionalPrefixes: [],
    showConventionalDropdown: false,
  });

  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(event.target as Node)) {
        setState(prev => ({ ...prev, showBranchDropdown: false }));
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch all git information
  const fetchGitInfo = useCallback(async () => {
    if (!cwd) return;

    try {
      const isRepo = await window.clausitron.gitIsRepo(cwd);

      if (!isRepo) {
        setState(prev => ({
          ...prev,
          isRepo: false,
          isLoading: false,
          error: null,
        }));
        return;
      }

      // Fetch all git info in parallel
      // Use gitAheadBehind separately for reliable push/pull state detection
      // Use gitBranches (simple) instead of gitBranchesWithHierarchy (slow O(n^2) git commands)
      const [detailedStatus, branchesResult, commitsResult, aheadBehindResult, stashResult, mergeInProgress, cherryPickInProgress, rebaseInProgress, tagsResult, conflictFilesResult, conventionalResult] = await Promise.all([
        window.clausitron.gitDetailedStatus(cwd),
        window.clausitron.gitBranches(cwd),
        window.clausitron.gitLogDetailed(cwd, 10),
        window.clausitron.gitAheadBehind(cwd),
        window.clausitron.gitStashList(cwd),
        window.clausitron.gitMergeInProgress(cwd),
        window.clausitron.gitCherryPickInProgress(cwd),
        window.clausitron.gitRebaseInProgress(cwd),
        window.clausitron.gitTags(cwd),
        window.clausitron.gitConflictFiles(cwd),
        window.clausitron.gitConventionalPrefixes(cwd),
      ]);

      setState(prev => ({
        ...prev,
        isRepo: true,
        isLoading: false,
        error: null,
        branch: detailedStatus.branch || 'unknown',
        // Use dedicated gitAheadBehind for reliable ahead/behind counts
        ahead: aheadBehindResult.ahead || 0,
        behind: aheadBehindResult.behind || 0,
        hasRemote: aheadBehindResult.hasRemote || false,
        hasUpstream: aheadBehindResult.hasUpstream || false,
        staged: detailedStatus.staged || [],
        unstaged: detailedStatus.unstaged || [],
        untracked: detailedStatus.untracked || [],
        branches: branchesResult.branches || [],
        commits: commitsResult.commits || [],
        stashes: stashResult.stashes || [],
        mergeInProgress: mergeInProgress || false,
        cherryPickInProgress: cherryPickInProgress || false,
        rebaseInProgress: rebaseInProgress || false,
        tags: tagsResult.tags || [],
        conflictFiles: conflictFilesResult.files || [],
        conventionalPrefixes: conventionalResult.prefixes || [],
      }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch git info',
      }));
    }
  }, [cwd]);

  // Initial fetch
  useEffect(() => {
    fetchGitInfo();
  }, [fetchGitInfo]);

  // Auto-refresh (faster when panel is open - every 3 seconds)
  useEffect(() => {
    if (!gitAutoRefresh || !state.isRepo) return;

    const interval = setInterval(fetchGitInfo, 3000);
    return () => clearInterval(interval);
  }, [fetchGitInfo, gitAutoRefresh, state.isRepo]);

  // Stage file(s)
  const handleStage = async (files: string[]) => {
    setState(prev => ({ ...prev, operationInProgress: 'staging' }));
    try {
      await window.clausitron.gitStage(cwd, files);
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to stage files:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Unstage file(s)
  const handleUnstage = async (files: string[]) => {
    setState(prev => ({ ...prev, operationInProgress: 'unstaging' }));
    try {
      await window.clausitron.gitUnstage(cwd, files);
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to unstage files:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Stage all changes
  const handleStageAll = async () => {
    const allFiles = [...state.unstaged.map(f => f.file), ...state.untracked.map(f => f.file)];
    if (allFiles.length > 0) {
      await handleStage(allFiles);
    }
  };

  // Unstage all
  const handleUnstageAll = async () => {
    if (state.staged.length > 0) {
      await handleUnstage(state.staged.map(f => f.file));
    }
  };

  // Discard changes
  const handleDiscard = async (file: string, isUntracked: boolean) => {
    if (!confirm(`Discard changes to ${file}? This cannot be undone.`)) return;

    setState(prev => ({ ...prev, operationInProgress: 'discarding' }));
    try {
      if (isUntracked) {
        await window.clausitron.gitCleanFile(cwd, file);
      } else {
        await window.clausitron.gitDiscardChanges(cwd, [file]);
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to discard changes:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Commit
  const handleCommit = async () => {
    if (!state.commitMessage.trim() || state.staged.length === 0) return;

    setState(prev => ({ ...prev, isCommitting: true }));
    try {
      const result = await window.clausitron.gitCommit(cwd, state.commitMessage.trim());
      if (result.success) {
        setState(prev => ({ ...prev, commitMessage: '' }));
        await fetchGitInfo();
      } else {
        alert(`Commit failed: ${result.error}`);
      }
    } catch (err) {
      console.error('Failed to commit:', err);
    }
    setState(prev => ({ ...prev, isCommitting: false }));
  };

  // Push
  const handlePush = async () => {
    setState(prev => ({ ...prev, isPushing: true }));
    try {
      const result = await window.clausitron.gitPush(cwd);
      if (!result.success) {
        alert(`Push failed: ${result.error}`);
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to push:', err);
    }
    setState(prev => ({ ...prev, isPushing: false }));
  };

  // Pull
  const handlePull = async () => {
    setState(prev => ({ ...prev, isPulling: true }));
    try {
      const result = await window.clausitron.gitPull(cwd);
      if (!result.success) {
        alert(`Pull failed: ${result.error}`);
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to pull:', err);
    }
    setState(prev => ({ ...prev, isPulling: false }));
  };

  // Fetch
  const handleFetch = async () => {
    setState(prev => ({ ...prev, isFetching: true }));
    try {
      await window.clausitron.gitFetch(cwd);
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to fetch:', err);
    }
    setState(prev => ({ ...prev, isFetching: false }));
  };

  // Checkout branch - checks for uncommitted changes first
  const handleCheckout = async (branch: string) => {
    // Check if there are uncommitted changes (staged, unstaged, or untracked)
    const hasChanges = state.staged.length > 0 || state.unstaged.length > 0;

    if (hasChanges) {
      // Show confirmation modal instead of attempting checkout
      setState(prev => ({
        ...prev,
        showBranchDropdown: false,
        showCheckoutConfirmModal: true,
        pendingCheckoutBranch: branch,
      }));
      return;
    }

    // No changes, proceed with checkout directly
    await performCheckout(branch);
  };

  // Actually perform the checkout (called directly or after confirmation)
  const performCheckout = async (branch: string) => {
    setState(prev => ({
      ...prev,
      operationInProgress: 'checkout',
      showBranchDropdown: false,
      showCheckoutConfirmModal: false,
      pendingCheckoutBranch: null,
    }));

    try {
      const result = await window.clausitron.gitCheckout(cwd, branch);
      if (!result.success) {
        // Show error but don't corrupt state
        console.error('Checkout failed:', result.error);
        // Use a more user-friendly approach - could also use a toast here
        setState(prev => ({
          ...prev,
          operationInProgress: null,
          error: `Checkout failed: ${result.error}`,
        }));
        // Clear error after 5 seconds
        setTimeout(() => {
          setState(prev => prev.error?.startsWith('Checkout failed') ? { ...prev, error: null } : prev);
        }, 5000);
        return;
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to checkout:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Handle discard and checkout (user confirmed they want to discard changes)
  const handleDiscardAndCheckout = async () => {
    const branch = state.pendingCheckoutBranch;
    if (!branch) return;

    setState(prev => ({
      ...prev,
      operationInProgress: 'discarding',
      showCheckoutConfirmModal: false,
    }));

    try {
      // Discard all staged changes (unstage them first)
      if (state.staged.length > 0) {
        await window.clausitron.gitUnstage(cwd, state.staged.map(f => f.file));
      }

      // Discard all unstaged changes
      const filesToDiscard = state.unstaged.filter(f => f.status !== 'untracked').map(f => f.file);
      if (filesToDiscard.length > 0) {
        await window.clausitron.gitDiscardChanges(cwd, filesToDiscard);
      }

      // Now perform the checkout
      await performCheckout(branch);
    } catch (err) {
      console.error('Failed to discard changes:', err);
      setState(prev => ({
        ...prev,
        operationInProgress: null,
        pendingCheckoutBranch: null,
        error: 'Failed to discard changes',
      }));
    }
  };

  // Cancel the checkout confirmation
  const handleCancelCheckout = () => {
    setState(prev => ({
      ...prev,
      showCheckoutConfirmModal: false,
      pendingCheckoutBranch: null,
      operationInProgress: null,
    }));
  };

  // Create new branch
  const handleCreateBranch = async () => {
    const branchName = state.newBranchName.trim();
    if (!branchName) return;

    // Clear any previous error
    setState(prev => ({ ...prev, newBranchError: null, operationInProgress: 'creating-branch' }));

    try {
      const result = await window.clausitron.gitCreateBranch(cwd, branchName, true);
      if (result.success) {
        setState(prev => ({
          ...prev,
          newBranchName: '',
          showNewBranchInput: false,
          newBranchError: null,
          operationInProgress: null,
        }));
        await fetchGitInfo();
      } else {
        // Display error inline instead of using alert() which causes focus issues
        setState(prev => ({
          ...prev,
          newBranchError: result.error || 'Failed to create branch',
          operationInProgress: null,
        }));
      }
    } catch (err) {
      console.error('Failed to create branch:', err);
      setState(prev => ({
        ...prev,
        newBranchError: 'An unexpected error occurred',
        operationInProgress: null,
      }));
    }
  };

  // Cancel new branch input and clear error state
  const handleCancelNewBranch = () => {
    setState(prev => ({
      ...prev,
      showNewBranchInput: false,
      newBranchName: '',
      newBranchError: null,
    }));
  };

  // Merge branch
  const handleMerge = async () => {
    if (!state.mergeBranch) return;

    setState(prev => ({ ...prev, isMerging: true, showMergeModal: false }));
    try {
      const result = await window.clausitron.gitMerge(cwd, state.mergeBranch, state.mergeOptions);
      if (!result.success) {
        // Check if it's a conflict
        if (result.error?.includes('conflict') || result.stderr?.includes('CONFLICT')) {
          setState(prev => ({
            ...prev,
            isMerging: false,
            mergeInProgress: true,
            error: 'Merge has conflicts - resolve them and commit',
          }));
        } else {
          setState(prev => ({
            ...prev,
            isMerging: false,
            error: `Merge failed: ${result.error}`,
          }));
        }
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to merge:', err);
      setState(prev => ({ ...prev, isMerging: false }));
    }
    setState(prev => ({
      ...prev,
      isMerging: false,
      mergeBranch: null,
      mergeOptions: { noFf: false, squash: false },
    }));
  };

  // Abort merge
  const handleMergeAbort = async () => {
    try {
      const result = await window.clausitron.gitMergeAbort(cwd);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to abort merge: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to abort merge:', err);
    }
  };

  // Stash changes
  const handleStashPush = async () => {
    setState(prev => ({ ...prev, operationInProgress: 'stashing', showStashModal: false }));
    try {
      const result = await window.clausitron.gitStashPush(cwd, state.stashMessage || undefined);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Stash failed: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to stash:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null, stashMessage: '' }));
  };

  // Pop stash
  const handleStashPop = async (index?: number) => {
    setState(prev => ({ ...prev, operationInProgress: 'popping-stash' }));
    try {
      const result = await window.clausitron.gitStashPop(cwd, index);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Stash pop failed: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to pop stash:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Apply stash
  const handleStashApply = async (index?: number) => {
    setState(prev => ({ ...prev, operationInProgress: 'applying-stash' }));
    try {
      const result = await window.clausitron.gitStashApply(cwd, index);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Stash apply failed: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to apply stash:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Drop stash
  const handleStashDrop = async (index: number) => {
    if (!confirm(`Drop stash@{${index}}? This cannot be undone.`)) return;

    setState(prev => ({ ...prev, operationInProgress: 'dropping-stash' }));
    try {
      const result = await window.clausitron.gitStashDrop(cwd, index);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Stash drop failed: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to drop stash:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // ============================================================================
  // NEW GIT ENHANCEMENT HANDLERS
  // ============================================================================

  // Commit with amend option
  const handleCommitWithAmend = async () => {
    if (state.amendMode) {
      // Amend mode - either add staged changes or just change message
      setState(prev => ({ ...prev, isCommitting: true }));
      try {
        const result = await window.clausitron.gitCommitAmend(cwd, {
          message: state.commitMessage.trim() || undefined,
          noEdit: !state.commitMessage.trim(),
        });
        if (result.success) {
          setState(prev => ({ ...prev, commitMessage: '', amendMode: false }));
          await fetchGitInfo();
        } else {
          alert(`Amend failed: ${result.error}`);
        }
      } catch (err) {
        console.error('Failed to amend:', err);
      }
      setState(prev => ({ ...prev, isCommitting: false }));
    } else {
      // Normal commit
      await handleCommit();
    }
  };

  // Delete branch
  const handleDeleteBranch = async () => {
    if (!state.branchToDelete) return;

    setState(prev => ({ ...prev, operationInProgress: 'deleting-branch' }));
    try {
      const result = await window.clausitron.gitDeleteBranch(cwd, state.branchToDelete, {
        force: state.deleteBranchForce,
      });
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to delete branch: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to delete branch:', err);
    }
    setState(prev => ({
      ...prev,
      operationInProgress: null,
      showDeleteBranchModal: false,
      branchToDelete: null,
      deleteBranchForce: false,
    }));
  };

  // Cherry-pick a commit
  const handleCherryPick = async (commit: string) => {
    setState(prev => ({ ...prev, operationInProgress: 'cherry-picking' }));
    try {
      const result = await window.clausitron.gitCherryPick(cwd, commit);
      if (!result.success) {
        if (result.error?.includes('conflict') || result.stderr?.includes('CONFLICT')) {
          setState(prev => ({
            ...prev,
            error: 'Cherry-pick has conflicts - resolve them and continue',
          }));
        } else {
          setState(prev => ({ ...prev, error: `Cherry-pick failed: ${result.error}` }));
        }
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to cherry-pick:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Cherry-pick abort
  const handleCherryPickAbort = async () => {
    try {
      await window.clausitron.gitCherryPickAbort(cwd);
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to abort cherry-pick:', err);
    }
  };

  // Cherry-pick continue
  const handleCherryPickContinue = async () => {
    setState(prev => ({ ...prev, operationInProgress: 'cherry-pick-continue' }));
    try {
      const result = await window.clausitron.gitCherryPickContinue(cwd);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Continue failed: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to continue cherry-pick:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Rebase
  const handleRebase = async () => {
    if (!state.rebaseBranch) return;

    setState(prev => ({ ...prev, operationInProgress: 'rebasing', showRebaseModal: false }));
    try {
      const result = await window.clausitron.gitRebase(cwd, state.rebaseBranch);
      if (!result.success) {
        if (result.error?.includes('conflict') || result.stderr?.includes('CONFLICT')) {
          setState(prev => ({
            ...prev,
            error: 'Rebase has conflicts - resolve them and continue',
          }));
        } else {
          setState(prev => ({ ...prev, error: `Rebase failed: ${result.error}` }));
        }
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to rebase:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null, rebaseBranch: null }));
  };

  // Rebase abort
  const handleRebaseAbort = async () => {
    try {
      await window.clausitron.gitRebaseAbort(cwd);
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to abort rebase:', err);
    }
  };

  // Rebase continue
  const handleRebaseContinue = async () => {
    setState(prev => ({ ...prev, operationInProgress: 'rebase-continue' }));
    try {
      const result = await window.clausitron.gitRebaseContinue(cwd);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Continue failed: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to continue rebase:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Rebase skip
  const handleRebaseSkip = async () => {
    try {
      await window.clausitron.gitRebaseSkip(cwd);
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to skip rebase step:', err);
    }
  };

  // Create tag
  const handleCreateTag = async () => {
    if (!state.newTagName.trim()) return;

    setState(prev => ({ ...prev, operationInProgress: 'creating-tag' }));
    try {
      const result = await window.clausitron.gitCreateTag(cwd, state.newTagName.trim(), {
        message: state.newTagMessage.trim() || undefined,
        commit: state.newTagCommit.trim() || undefined,
      });
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to create tag: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to create tag:', err);
    }
    setState(prev => ({
      ...prev,
      operationInProgress: null,
      showTagModal: false,
      newTagName: '',
      newTagMessage: '',
      newTagCommit: '',
    }));
  };

  // Delete tag
  const handleDeleteTag = async (name: string) => {
    if (!confirm(`Delete tag "${name}"?`)) return;

    setState(prev => ({ ...prev, operationInProgress: 'deleting-tag' }));
    try {
      const result = await window.clausitron.gitDeleteTag(cwd, name);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to delete tag: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to delete tag:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Conflict resolution - accept ours
  const handleResolveOurs = async (file: string) => {
    setState(prev => ({ ...prev, operationInProgress: 'resolving' }));
    try {
      const result = await window.clausitron.gitResolveOurs(cwd, file);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to resolve: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to resolve conflict:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // Conflict resolution - accept theirs
  const handleResolveTheirs = async (file: string) => {
    setState(prev => ({ ...prev, operationInProgress: 'resolving' }));
    try {
      const result = await window.clausitron.gitResolveTheirs(cwd, file);
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to resolve: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to resolve conflict:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  };

  // View file history
  const handleViewFileHistory = async (file: string) => {
    setState(prev => ({
      ...prev,
      showFileHistoryModal: true,
      fileHistoryFile: file,
      isLoadingFileHistory: true,
    }));
    try {
      const result = await window.clausitron.gitFileHistory(cwd, file);
      if (result.success) {
        setState(prev => ({
          ...prev,
          fileHistoryCommits: result.commits,
          isLoadingFileHistory: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingFileHistory: false,
          error: `Failed to load file history: ${result.error}`,
        }));
      }
    } catch (err) {
      console.error('Failed to load file history:', err);
      setState(prev => ({ ...prev, isLoadingFileHistory: false }));
    }
  };

  // View git blame
  const handleViewBlame = async (file: string) => {
    setState(prev => ({
      ...prev,
      showBlameModal: true,
      blameFile: file,
      isLoadingBlame: true,
    }));
    try {
      const result = await window.clausitron.gitBlame(cwd, file);
      if (result.success) {
        setState(prev => ({
          ...prev,
          blameLines: result.lines,
          isLoadingBlame: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingBlame: false,
          error: `Failed to load blame: ${result.error}`,
        }));
      }
    } catch (err) {
      console.error('Failed to load blame:', err);
      setState(prev => ({ ...prev, isLoadingBlame: false }));
    }
  };

  // View reflog
  const handleViewReflog = async () => {
    setState(prev => ({
      ...prev,
      showReflogModal: true,
      isLoadingReflog: true,
    }));
    try {
      const result = await window.clausitron.gitReflog(cwd);
      if (result.success) {
        setState(prev => ({
          ...prev,
          reflogEntries: result.entries,
          isLoadingReflog: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingReflog: false,
          error: `Failed to load reflog: ${result.error}`,
        }));
      }
    } catch (err) {
      console.error('Failed to load reflog:', err);
      setState(prev => ({ ...prev, isLoadingReflog: false }));
    }
  };

  // Reset to reflog entry
  const handleResetToReflog = async (index: number, hard: boolean = false) => {
    const confirmMsg = hard
      ? `Hard reset to HEAD@{${index}}? This will discard all uncommitted changes!`
      : `Reset to HEAD@{${index}}?`;
    if (!confirm(confirmMsg)) return;

    setState(prev => ({ ...prev, operationInProgress: 'resetting' }));
    try {
      const result = await window.clausitron.gitResetToReflog(cwd, index, { hard });
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to reset: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      console.error('Failed to reset:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null, showReflogModal: false }));
  };

  // Insert conventional commit prefix
  const handleConventionalPrefix = (prefix: string) => {
    const currentMsg = state.commitMessage;
    // Check if message already starts with a prefix
    const hasPrefix = /^[a-z]+(\([^)]+\))?:/.test(currentMsg);
    if (hasPrefix) {
      // Replace existing prefix
      setState(prev => ({
        ...prev,
        commitMessage: currentMsg.replace(/^[a-z]+(\([^)]+\))?:\s*/, `${prefix}: `),
        showConventionalDropdown: false,
      }));
    } else {
      // Add prefix
      setState(prev => ({
        ...prev,
        commitMessage: `${prefix}: ${currentMsg}`,
        showConventionalDropdown: false,
      }));
    }
  };

  // View commit details
  const handleViewCommit = async (hash: string) => {
    setState(prev => ({ ...prev, isLoadingCommit: true, showCommitDetail: true }));
    try {
      const result = await window.clausitron.gitShowCommit(cwd, hash);
      if (result.success && result.commit) {
        setState(prev => ({
          ...prev,
          selectedCommit: result.commit,
          isLoadingCommit: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingCommit: false,
          showCommitDetail: false,
        }));
        console.error('Failed to load commit:', result.error);
      }
    } catch (err) {
      console.error('Failed to load commit:', err);
      setState(prev => ({ ...prev, isLoadingCommit: false, showCommitDetail: false }));
    }
  };

  // Close commit detail modal
  const handleCloseCommitDetail = () => {
    setState(prev => ({
      ...prev,
      showCommitDetail: false,
      selectedCommit: null,
    }));
  };

  // View file diff
  const handleViewDiff = async (file: string, isStaged: boolean = false, commit?: string) => {
    setState(prev => ({
      ...prev,
      isLoadingDiff: true,
      showDiffModal: true,
      diffFile: file,
      diffIsStaged: isStaged,
      diffCommit: commit || null,
    }));
    try {
      const result = await window.clausitron.gitDiffRaw(cwd, {
        file,
        staged: isStaged,
        commit,
      });
      if (result.success) {
        setState(prev => ({
          ...prev,
          diffContent: result.output || '(No differences)',
          isLoadingDiff: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          diffContent: `Error: ${result.error}`,
          isLoadingDiff: false,
        }));
      }
    } catch (err) {
      console.error('Failed to load diff:', err);
      setState(prev => ({
        ...prev,
        diffContent: 'Failed to load diff',
        isLoadingDiff: false,
      }));
    }
  };

  // Close diff modal
  const handleCloseDiffModal = () => {
    setState(prev => ({
      ...prev,
      showDiffModal: false,
      diffFile: null,
      diffContent: null,
      diffCommit: null,
    }));
  };

  // Toggle section expand/collapse
  const toggleSection = (section: keyof GitPanelState['expandedSections']) => {
    setState(prev => ({
      ...prev,
      expandedSections: {
        ...prev.expandedSections,
        [section]: !prev.expandedSections[section],
      },
    }));
  };

  // Get status icon and color for a file
  const getStatusDisplay = (change: GitFileChange) => {
    const statusMap: Record<string, { icon: string; color: string; label: string }> = {
      modified: { icon: 'M', color: 'text-primary-400 bg-primary-400/20', label: 'Modified' },
      added: { icon: 'A', color: 'text-success-400 bg-success-400/20', label: 'Added' },
      deleted: { icon: 'D', color: 'text-error-400 bg-error-400/20', label: 'Deleted' },
      renamed: { icon: 'R', color: 'text-accent-400 bg-accent-400/20', label: 'Renamed' },
      copied: { icon: 'C', color: 'text-info-400 bg-info-400/20', label: 'Copied' },
      untracked: { icon: 'U', color: 'text-warning-400 bg-warning-400/20', label: 'Untracked' },
      ignored: { icon: '!', color: 'text-surface-500 bg-surface-500/20', label: 'Ignored' },
    };
    return statusMap[change.status] || { icon: '?', color: 'text-surface-400 bg-surface-400/20', label: 'Unknown' };
  };

  // Format relative time
  const formatRelativeTime = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Render file change row
  const renderFileChange = (change: GitFileChange, showStageButton: boolean, showUnstageButton: boolean, showDiscardButton: boolean) => {
    const { icon, color, label } = getStatusDisplay(change);
    const fileName = change.file.split('/').pop() || change.file;
    const filePath = change.file.includes('/') ? change.file.substring(0, change.file.lastIndexOf('/')) : '';
    const canViewDiff = change.status !== 'untracked' && change.status !== 'deleted';

    return (
      <div
        key={change.file}
        className="group flex items-center gap-1.5 px-2 py-1 hover:bg-surface-700/50 rounded text-xs"
        title={`${label}: ${change.file}${change.originalPath ? ` (from ${change.originalPath})` : ''}`}
      >
        <span className={clsx('w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold flex-shrink-0', color)}>
          {icon}
        </span>
        <button
          className="flex-1 min-w-0 flex flex-col text-left hover:text-primary-400 transition-colors"
          onClick={() => canViewDiff && handleViewDiff(change.file, change.staged)}
          disabled={!canViewDiff}
          title={canViewDiff ? 'Click to view diff' : undefined}
        >
          <span className="truncate text-surface-200 font-mono group-hover:text-inherit">{fileName}</span>
          {filePath && <span className="truncate text-surface-500 text-[10px]">{filePath}</span>}
        </button>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {canViewDiff && (
            <button
              onClick={() => handleViewDiff(change.file, change.staged)}
              className="p-1 rounded hover:bg-primary-500/20 text-primary-400"
              title="View Diff"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </button>
          )}
          {change.status !== 'untracked' && (
            <>
              <button
                onClick={() => handleViewBlame(change.file)}
                className="p-1 rounded hover:bg-info-500/20 text-info-400"
                title="Blame"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </button>
              <button
                onClick={() => handleViewFileHistory(change.file)}
                className="p-1 rounded hover:bg-accent-500/20 text-accent-400"
                title="History"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </>
          )}
          {showStageButton && (
            <button
              onClick={() => handleStage([change.file])}
              className="p-1 rounded hover:bg-success-500/20 text-success-400"
              title="Stage"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          )}
          {showUnstageButton && (
            <button
              onClick={() => handleUnstage([change.file])}
              className="p-1 rounded hover:bg-warning-500/20 text-warning-400"
              title="Unstage"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
          )}
          {showDiscardButton && (
            <button
              onClick={() => handleDiscard(change.file, change.status === 'untracked')}
              className="p-1 rounded hover:bg-error-500/20 text-error-400"
              title="Discard"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
    );
  };

  const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;

  // Sort branches: main/master first, then alphabetically but grouped by parent
  const localBranches = useMemo(() => {
    const branches = state.branches.filter(b => !b.isRemote);

    // Separate main branches from others
    const mainBranches = branches.filter(b => b.name === 'main' || b.name === 'master');
    const otherBranches = branches.filter(b => b.name !== 'main' && b.name !== 'master');

    // Sort other branches: those without parents first, then by parent grouping
    const sortedOthers = otherBranches.sort((a, b) => {
      // Branches without parents come first (after main)
      if (!a.parentBranch && b.parentBranch) return -1;
      if (a.parentBranch && !b.parentBranch) return 1;

      // If same parent, sort alphabetically
      if (a.parentBranch === b.parentBranch) {
        return a.name.localeCompare(b.name);
      }

      // Group by parent: if a's parent is b's name, a comes after b
      if (a.parentBranch === b.name) return 1;
      if (b.parentBranch === a.name) return -1;

      // Otherwise sort alphabetically
      return a.name.localeCompare(b.name);
    });

    return [...mainBranches, ...sortedOthers];
  }, [state.branches]);

  return (
    <div
      className={clsx(
        'w-72 flex-shrink-0 bg-surface-900 overflow-hidden flex flex-col',
        position === 'left' ? 'border-r border-surface-800' : 'border-l border-surface-800'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-800">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18V6M6 6a3 3 0 100-6 3 3 0 000 6zm12 12a3 3 0 100-6 3 3 0 000 6zm0 0V9a3 3 0 00-3-3H9" />
          </svg>
          <span className="text-sm font-medium text-surface-200">Source Control</span>
          {totalChanges > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-primary-500/20 text-primary-400 rounded-full">
              {totalChanges}
            </span>
          )}
        </div>
        <button
          onClick={fetchGitInfo}
          className="p-1 rounded hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
          title="Refresh (Ctrl+Shift+G)"
          disabled={state.isLoading}
        >
          <svg
            className={clsx('w-3.5 h-3.5', state.isLoading && 'animate-spin')}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {state.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-5 h-5 border-2 border-surface-600 border-t-primary-500 rounded-full" />
          </div>
        ) : state.error ? (
          <div className="text-xs text-error-400 p-3 m-2 bg-error-500/10 rounded">
            {state.error}
          </div>
        ) : !state.isRepo ? (
          <div className="text-center py-8 px-4">
            <div className="text-4xl mb-3">{'</>'}</div>
            <div className="text-surface-400 text-sm mb-3">Not a git repository</div>
            <button
              onClick={async () => {
                await window.clausitron.gitInit(cwd);
                fetchGitInfo();
              }}
              className="px-3 py-1.5 text-xs bg-primary-500 hover:bg-primary-600 text-white rounded transition-colors"
            >
              Initialize Repository
            </button>
          </div>
        ) : (
          <div className="p-2 space-y-2">
            {/* Branch Selector */}
            <div className="relative" ref={branchDropdownRef}>
              <button
                onClick={() => setState(prev => ({ ...prev, showBranchDropdown: !prev.showBranchDropdown }))}
                className="w-full flex items-center gap-2 px-2 py-1.5 bg-surface-800 hover:bg-surface-700 rounded text-sm transition-colors"
              >
                <svg className="w-3.5 h-3.5 text-success-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18V6M6 6a3 3 0 100-6 3 3 0 000 6zm12 12a3 3 0 100-6 3 3 0 000 6zm0 0V9a3 3 0 00-3-3H9" />
                </svg>
                <span className="text-surface-100 font-mono truncate flex-1 text-left">{state.branch}</span>
                {(state.ahead > 0 || state.behind > 0) && (
                  <span className="text-xs text-surface-400">
                    {state.ahead > 0 && <span className="text-success-400">{state.ahead}+</span>}
                    {state.ahead > 0 && state.behind > 0 && ' '}
                    {state.behind > 0 && <span className="text-warning-400">{state.behind}-</span>}
                  </span>
                )}
                <svg className="w-3 h-3 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Branch Dropdown */}
              {state.showBranchDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-surface-800 border border-surface-700 rounded shadow-lg z-[9959] max-h-64 overflow-y-auto">
                  {/* New Branch Input */}
                  {state.showNewBranchInput ? (
                    <div className="p-2 border-b border-surface-700">
                      <input
                        type="text"
                        value={state.newBranchName}
                        onChange={(e) => setState(prev => ({ ...prev, newBranchName: e.target.value, newBranchError: null }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCreateBranch();
                          if (e.key === 'Escape') handleCancelNewBranch();
                        }}
                        placeholder="New branch name..."
                        className={clsx(
                          'w-full px-2 py-1 text-xs bg-surface-900 border rounded text-surface-100 placeholder-surface-500 focus:outline-none',
                          state.newBranchError
                            ? 'border-error-500 focus:border-error-500'
                            : 'border-surface-600 focus:border-primary-500'
                        )}
                        autoFocus
                      />
                      {/* Inline error message */}
                      {state.newBranchError && (
                        <div className="mt-1 px-1 text-[10px] text-error-400">
                          {state.newBranchError}
                        </div>
                      )}
                      <div className="flex gap-1 mt-1">
                        <button
                          onClick={handleCreateBranch}
                          disabled={!state.newBranchName.trim() || state.operationInProgress === 'creating-branch'}
                          className="flex-1 px-2 py-1 text-xs bg-primary-500 hover:bg-primary-600 disabled:bg-surface-600 text-white rounded"
                        >
                          {state.operationInProgress === 'creating-branch' ? 'Creating...' : 'Create'}
                        </button>
                        <button
                          onClick={handleCancelNewBranch}
                          className="px-2 py-1 text-xs bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setState(prev => ({ ...prev, showNewBranchInput: true, newBranchError: null }))}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-primary-400 hover:bg-surface-700 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Create new branch...
                    </button>
                  )}

                  {/* Branch List */}
                  {localBranches.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-surface-500 italic">
                      No local branches found
                    </div>
                  ) : (
                    localBranches.map((branch) => {
                      // Determine if this is a child branch (has a parent)
                      const hasParent = !!branch.parentBranch;
                      const isMainBranch = branch.name === 'main' || branch.name === 'master';
                      const canDelete = !branch.isCurrent && !isMainBranch;

                      return (
                        <div
                          key={branch.name}
                          className={clsx(
                            'group w-full flex items-center gap-2 py-1.5 text-xs hover:bg-surface-700 transition-colors',
                            branch.isCurrent && 'bg-surface-700/50',
                            hasParent ? 'px-5' : 'px-3'
                          )}
                        >
                          <button
                            onClick={() => handleCheckout(branch.name)}
                            disabled={branch.isCurrent}
                            className="flex items-center gap-2 flex-1 min-w-0"
                          >
                            {/* Tree line indicator for child branches */}
                            {hasParent && (
                              <span className="text-surface-600 text-[10px] -ml-2 mr-0">
                                {'|_'}
                              </span>
                            )}
                            {branch.isCurrent ? (
                              <svg className="w-3 h-3 text-success-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : (
                              <span className="w-3 flex-shrink-0" />
                            )}
                            <div className="flex flex-col items-start min-w-0 flex-1">
                              <span className={clsx(
                                'font-mono truncate w-full text-left',
                                branch.isCurrent ? 'text-surface-100' : 'text-surface-300',
                                isMainBranch && 'font-semibold'
                              )}>
                                {branch.name}
                              </span>
                              {/* Show parent branch info */}
                              {hasParent && (
                                <span className="text-[10px] text-surface-500 truncate w-full text-left">
                                  from {branch.parentBranch}
                                  {branch.commitsAhead && branch.commitsAhead > 0 && (
                                    <span className="text-primary-400 ml-1">+{branch.commitsAhead}</span>
                                  )}
                                </span>
                              )}
                            </div>
                          </button>
                          {canDelete && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setState(prev => ({ ...prev, showDeleteBranchModal: true, branchToDelete: branch.name }));
                              }}
                              className="p-1 rounded hover:bg-error-500/20 text-error-400 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Delete branch"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* Push/Pull/Fetch/Merge Actions */}
            <div className="flex gap-1">
              <button
                onClick={handlePush}
                disabled={state.isPushing || !state.hasRemote || state.ahead === 0}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
                  state.hasRemote && state.ahead > 0
                    ? 'bg-success-500/20 text-success-400 hover:bg-success-500/30'
                    : 'bg-surface-800 text-surface-500 cursor-not-allowed'
                )}
                title={state.hasRemote
                  ? (state.ahead > 0 ? `Push ${state.ahead} commit${state.ahead !== 1 ? 's' : ''}` : 'Nothing to push')
                  : 'No remote configured'}
              >
                {state.isPushing ? (
                  <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
                  </svg>
                )}
                {state.ahead > 0 && <span>{state.ahead}</span>}
              </button>
              <button
                onClick={handlePull}
                disabled={state.isPulling || !state.hasRemote || state.behind === 0}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
                  state.hasRemote && state.behind > 0
                    ? 'bg-warning-500/20 text-warning-400 hover:bg-warning-500/30'
                    : 'bg-surface-800 text-surface-500 cursor-not-allowed'
                )}
                title={state.hasRemote
                  ? (state.behind > 0 ? `Pull ${state.behind} commit${state.behind !== 1 ? 's' : ''}` : 'Up to date')
                  : 'No remote configured'}
              >
                {state.isPulling ? (
                  <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 13l-5 5m0 0l-5-5m5 5V6" />
                  </svg>
                )}
                {state.behind > 0 && <span>{state.behind}</span>}
              </button>
              <button
                onClick={handleFetch}
                disabled={state.isFetching || !state.hasRemote}
                className={clsx(
                  'px-2 py-1.5 text-xs rounded transition-colors',
                  state.hasRemote
                    ? 'bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-surface-200'
                    : 'bg-surface-800 text-surface-500 cursor-not-allowed'
                )}
                title={state.hasRemote ? 'Fetch from remote' : 'No remote configured'}
              >
                {state.isFetching ? (
                  <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => setState(prev => ({ ...prev, showMergeModal: true }))}
                disabled={state.isMerging || state.mergeInProgress}
                className={clsx(
                  'px-2 py-1.5 text-xs rounded transition-colors',
                  state.mergeInProgress
                    ? 'bg-warning-500/20 text-warning-400'
                    : 'bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-surface-200'
                )}
                title={state.mergeInProgress ? 'Merge in progress' : 'Merge branch'}
              >
                {state.isMerging ? (
                  <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                )}
              </button>
            </div>

            {/* Merge in progress banner */}
            {state.mergeInProgress && (
              <div className="flex items-center justify-between px-2 py-1.5 bg-warning-500/20 border border-warning-500/30 rounded text-xs">
                <span className="text-warning-400">Merge in progress - resolve conflicts and commit</span>
                <button
                  onClick={handleMergeAbort}
                  className="px-2 py-0.5 bg-warning-500/30 hover:bg-warning-500/40 text-warning-300 rounded transition-colors"
                >
                  Abort
                </button>
              </div>
            )}

            {/* Cherry-pick in progress banner */}
            {state.cherryPickInProgress && (
              <div className="flex items-center justify-between px-2 py-1.5 bg-accent-500/20 border border-accent-500/30 rounded text-xs">
                <span className="text-accent-400">Cherry-pick in progress</span>
                <div className="flex gap-1">
                  <button
                    onClick={handleCherryPickContinue}
                    className="px-2 py-0.5 bg-success-500/30 hover:bg-success-500/40 text-success-300 rounded transition-colors"
                  >
                    Continue
                  </button>
                  <button
                    onClick={handleCherryPickAbort}
                    className="px-2 py-0.5 bg-accent-500/30 hover:bg-accent-500/40 text-accent-300 rounded transition-colors"
                  >
                    Abort
                  </button>
                </div>
              </div>
            )}

            {/* Rebase in progress banner */}
            {state.rebaseInProgress && (
              <div className="flex items-center justify-between px-2 py-1.5 bg-accent-500/20 border border-accent-500/30 rounded text-xs">
                <span className="text-accent-400">Rebase in progress</span>
                <div className="flex gap-1">
                  <button
                    onClick={handleRebaseContinue}
                    className="px-2 py-0.5 bg-success-500/30 hover:bg-success-500/40 text-success-300 rounded transition-colors"
                  >
                    Continue
                  </button>
                  <button
                    onClick={handleRebaseSkip}
                    className="px-2 py-0.5 bg-warning-500/30 hover:bg-warning-500/40 text-warning-300 rounded transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    onClick={handleRebaseAbort}
                    className="px-2 py-0.5 bg-accent-500/30 hover:bg-accent-500/40 text-accent-300 rounded transition-colors"
                  >
                    Abort
                  </button>
                </div>
              </div>
            )}

            {/* Conflict Files Section */}
            {state.conflictFiles.length > 0 && (
              <div className="border border-error-500/30 bg-error-500/10 rounded overflow-hidden">
                <button
                  onClick={() => toggleSection('conflicts')}
                  className="w-full flex items-center gap-2 px-2 py-1.5 bg-error-500/20 hover:bg-error-500/30 transition-colors"
                >
                  <svg
                    className={clsx('w-3 h-3 text-error-400 transition-transform', state.expandedSections.conflicts && 'rotate-90')}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-xs font-medium text-error-400">Conflicts ({state.conflictFiles.length})</span>
                </button>
                {state.expandedSections.conflicts && (
                  <div className="max-h-40 overflow-y-auto">
                    {state.conflictFiles.map((conflict) => (
                      <div
                        key={conflict.file}
                        className="group flex items-center gap-2 px-2 py-1.5 hover:bg-error-500/10 text-xs"
                      >
                        <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-error-400 bg-error-400/20">
                          !
                        </span>
                        <span className="flex-1 text-surface-200 font-mono truncate">{conflict.file}</span>
                        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleResolveOurs(conflict.file)}
                            className="px-1.5 py-0.5 text-[10px] bg-primary-500/20 hover:bg-primary-500/30 text-primary-400 rounded"
                            title="Accept our version"
                          >
                            Ours
                          </button>
                          <button
                            onClick={() => handleResolveTheirs(conflict.file)}
                            className="px-1.5 py-0.5 text-[10px] bg-success-500/20 hover:bg-success-500/30 text-success-400 rounded"
                            title="Accept their version"
                          >
                            Theirs
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Commit Section */}
            {(state.staged.length > 0 || state.commitMessage || state.amendMode) && (
              <div className="border border-surface-700 rounded p-2 space-y-2">
                {/* Conventional commit dropdown */}
                <div className="relative">
                  <div className="flex gap-1">
                    <button
                      onClick={() => setState(prev => ({ ...prev, showConventionalDropdown: !prev.showConventionalDropdown }))}
                      className="px-2 py-1 text-[10px] bg-surface-800 hover:bg-surface-700 text-surface-400 rounded border border-surface-600"
                      title="Insert conventional commit prefix"
                    >
                      type:
                    </button>
                    <textarea
                      value={state.commitMessage}
                      onChange={(e) => setState(prev => ({ ...prev, commitMessage: e.target.value }))}
                      placeholder={state.amendMode ? "New commit message (leave empty to keep)" : "Commit message..."}
                      className="flex-1 px-2 py-1.5 text-xs bg-surface-800 border border-surface-700 rounded text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500 resize-none"
                      rows={2}
                    />
                  </div>
                  {state.showConventionalDropdown && (
                    <div className="absolute top-full left-0 mt-1 bg-surface-800 border border-surface-700 rounded shadow-lg z-[9959] max-h-40 overflow-y-auto">
                      {state.conventionalPrefixes.map(prefix => (
                        <button
                          key={prefix}
                          onClick={() => handleConventionalPrefix(prefix)}
                          className="w-full px-3 py-1.5 text-xs text-left text-surface-300 hover:bg-surface-700"
                        >
                          {prefix}:
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[10px] text-surface-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={state.amendMode}
                      onChange={(e) => setState(prev => ({ ...prev, amendMode: e.target.checked }))}
                      className="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500 w-3 h-3"
                    />
                    Amend last commit
                  </label>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={handleCommitWithAmend}
                    disabled={(!state.commitMessage.trim() && !state.amendMode) || (state.staged.length === 0 && !state.amendMode) || state.isCommitting}
                    className="flex-1 px-2 py-1.5 text-xs bg-primary-500 hover:bg-primary-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded transition-colors"
                  >
                    {state.isCommitting ? (state.amendMode ? 'Amending...' : 'Committing...') : (state.amendMode ? 'Amend' : `Commit (${state.staged.length})`)}
                  </button>
                </div>
              </div>
            )}

            {/* Staged Changes */}
            {state.staged.length > 0 && (
              <div className="border border-surface-700 rounded overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSection('staged')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('staged'); } }}
                  className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      className={clsx('w-3 h-3 text-surface-400 transition-transform', state.expandedSections.staged && 'rotate-90')}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-xs font-medium text-success-400">Staged Changes</span>
                    <span className="text-xs text-surface-500">({state.staged.length})</span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleUnstageAll(); }}
                    className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                    title="Unstage all"
                  >
                    - All
                  </button>
                </div>
                {state.expandedSections.staged && (
                  <div className="max-h-40 overflow-y-auto">
                    {state.staged.map((change) => renderFileChange(change, false, true, false))}
                  </div>
                )}
              </div>
            )}

            {/* Unstaged Changes */}
            {state.unstaged.length > 0 && (
              <div className="border border-surface-700 rounded overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSection('unstaged')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('unstaged'); } }}
                  className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      className={clsx('w-3 h-3 text-surface-400 transition-transform', state.expandedSections.unstaged && 'rotate-90')}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-xs font-medium text-primary-400">Changes</span>
                    <span className="text-xs text-surface-500">({state.unstaged.length})</span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleStageAll(); }}
                    className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                    title="Stage all"
                  >
                    + All
                  </button>
                </div>
                {state.expandedSections.unstaged && (
                  <div className="max-h-40 overflow-y-auto">
                    {state.unstaged.map((change) => renderFileChange(change, true, false, true))}
                  </div>
                )}
              </div>
            )}

            {/* Untracked Files */}
            {state.untracked.length > 0 && (
              <div className="border border-surface-700 rounded overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSection('untracked')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('untracked'); } }}
                  className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      className={clsx('w-3 h-3 text-surface-400 transition-transform', state.expandedSections.untracked && 'rotate-90')}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-xs font-medium text-warning-400">Untracked</span>
                    <span className="text-xs text-surface-500">({state.untracked.length})</span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleStage(state.untracked.map(f => f.file)); }}
                    className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                    title="Stage all untracked"
                  >
                    + All
                  </button>
                </div>
                {state.expandedSections.untracked && (
                  <div className="max-h-40 overflow-y-auto">
                    {state.untracked.map((change) => renderFileChange(change, true, false, true))}
                  </div>
                )}
              </div>
            )}

            {/* No Changes */}
            {totalChanges === 0 && (
              <div className="text-center py-4 text-xs text-surface-500">
                <svg className="w-8 h-8 mx-auto mb-2 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                </svg>
                Working tree clean
              </div>
            )}

            {/* Recent Commits */}
            <div className="border border-surface-700 rounded overflow-hidden">
              <button
                onClick={() => toggleSection('commits')}
                className="w-full flex items-center gap-2 px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors"
              >
                <svg
                  className={clsx('w-3 h-3 text-surface-400 transition-transform', state.expandedSections.commits && 'rotate-90')}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="text-xs font-medium text-surface-300">Commits</span>
              </button>
              {state.expandedSections.commits && (
                <div className="max-h-48 overflow-y-auto">
                  {state.commits.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-surface-500 text-center italic">
                      No commits yet
                    </div>
                  ) : (
                    state.commits.map((commit) => (
                      <div
                        key={commit.hash}
                        className="group flex items-start gap-2 px-2 py-1.5 hover:bg-surface-700/50 transition-colors"
                      >
                        <span className="text-primary-400 font-mono text-[10px] flex-shrink-0 mt-0.5">
                          {commit.shortHash}
                        </span>
                        <button
                          onClick={() => handleViewCommit(commit.hash)}
                          className="flex-1 min-w-0 text-left"
                          title={`Click to view commit details\n${commit.hash}\n${commit.author} <${commit.email}>\n${commit.date}`}
                        >
                          <div className="text-xs text-surface-200 truncate">{commit.subject}</div>
                          <div className="text-[10px] text-surface-500">
                            {commit.author} - {formatRelativeTime(commit.date)}
                          </div>
                        </button>
                        <button
                          onClick={() => handleCherryPick(commit.hash)}
                          className="p-1 rounded hover:bg-accent-500/20 text-accent-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Cherry-pick this commit"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                          </svg>
                        </button>
                        <svg className="w-3 h-3 text-surface-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Stashes Section */}
            <div className="border border-surface-700 rounded overflow-hidden">
              <button
                onClick={() => toggleSection('stashes')}
                className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className={clsx('w-3 h-3 text-surface-400 transition-transform', state.expandedSections.stashes && 'rotate-90')}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-xs font-medium text-surface-300">Stashes</span>
                  {state.stashes.length > 0 && (
                    <span className="text-xs text-surface-500">({state.stashes.length})</span>
                  )}
                </div>
                {(state.staged.length > 0 || state.unstaged.length > 0) && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, showStashModal: true })); }}
                    className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                    title="Stash changes"
                  >
                    + Stash
                  </button>
                )}
              </button>
              {state.expandedSections.stashes && (
                <div className="max-h-32 overflow-y-auto">
                  {state.stashes.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-surface-500 text-center italic">
                      No stashes
                    </div>
                  ) : (
                    state.stashes.map((stash) => (
                      <div
                        key={stash.index}
                        className="group flex items-center gap-2 px-2 py-1.5 hover:bg-surface-700/50 transition-colors"
                      >
                        <span className="text-accent-400 font-mono text-[10px] flex-shrink-0">
                          @{'{' + stash.index + '}'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-surface-200 truncate">{stash.message || 'WIP'}</div>
                          {stash.branch && (
                            <div className="text-[10px] text-surface-500">on {stash.branch}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleStashPop(stash.index)}
                            className="p-1 rounded hover:bg-success-500/20 text-success-400"
                            title="Pop (apply and remove)"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleStashApply(stash.index)}
                            className="p-1 rounded hover:bg-primary-500/20 text-primary-400"
                            title="Apply (keep stash)"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleStashDrop(stash.index)}
                            className="p-1 rounded hover:bg-error-500/20 text-error-400"
                            title="Drop"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Tags Section */}
            <div className="border border-surface-700 rounded overflow-hidden">
              <button
                onClick={() => toggleSection('tags')}
                className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className={clsx('w-3 h-3 text-surface-400 transition-transform', state.expandedSections.tags && 'rotate-90')}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-xs font-medium text-surface-300">Tags</span>
                  {state.tags.length > 0 && (
                    <span className="text-xs text-surface-500">({state.tags.length})</span>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, showTagModal: true })); }}
                  className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                  title="Create tag"
                >
                  + Tag
                </button>
              </button>
              {state.expandedSections.tags && (
                <div className="max-h-32 overflow-y-auto">
                  {state.tags.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-surface-500 text-center italic">
                      No tags
                    </div>
                  ) : (
                    state.tags.map((tag) => (
                      <div
                        key={tag.name}
                        className="group flex items-center gap-2 px-2 py-1.5 hover:bg-surface-700/50 transition-colors"
                      >
                        <span className={clsx(
                          'w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold flex-shrink-0',
                          tag.isAnnotated ? 'text-warning-400 bg-warning-400/20' : 'text-surface-400 bg-surface-400/20'
                        )}>
                          {tag.isAnnotated ? 'T' : 't'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-surface-200 font-mono truncate">{tag.name}</div>
                          {tag.message && (
                            <div className="text-[10px] text-surface-500 truncate">{tag.message}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleDeleteTag(tag.name)}
                            className="p-1 rounded hover:bg-error-500/20 text-error-400"
                            title="Delete tag"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Reflog Button */}
            <button
              onClick={handleViewReflog}
              className="w-full flex items-center gap-2 px-2 py-1.5 bg-surface-800 hover:bg-surface-700 rounded text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>View Reflog</span>
            </button>

            {/* Rebase Button */}
            <button
              onClick={() => setState(prev => ({ ...prev, showRebaseModal: true }))}
              disabled={state.rebaseInProgress}
              className="w-full flex items-center gap-2 px-2 py-1.5 bg-surface-800 hover:bg-surface-700 rounded text-xs text-surface-400 hover:text-surface-200 transition-colors disabled:opacity-50"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Rebase onto...</span>
            </button>

            {/* GitHub Integration Section */}
            {githubEnabled && githubShowInGitPanel && (
              <div className="border-t border-surface-700 pt-3 mt-3">
                <GitHubPanel
                  cwd={cwd}
                  currentBranch={state.branch}
                  className="h-auto max-h-96"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Commit Detail Modal */}
      {state.showCommitDetail && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={handleCloseCommitDetail}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="font-medium text-surface-100">Commit Details</span>
              </div>
              <button
                onClick={handleCloseCommitDetail}
                className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {state.isLoadingCommit ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
                </div>
              ) : state.selectedCommit ? (
                <div className="space-y-4">
                  {/* Commit Info */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-primary-400 font-mono text-sm">{state.selectedCommit.shortHash}</span>
                      <span className="text-surface-500 font-mono text-xs truncate">{state.selectedCommit.hash}</span>
                    </div>
                    <h3 className="text-lg font-medium text-surface-100">{state.selectedCommit.subject}</h3>
                    {state.selectedCommit.body && (
                      <p className="text-sm text-surface-400 whitespace-pre-wrap">{state.selectedCommit.body}</p>
                    )}
                    <div className="flex items-center gap-4 text-xs text-surface-500">
                      <span>{state.selectedCommit.author}</span>
                      <span>{new Date(state.selectedCommit.date).toLocaleString()}</span>
                    </div>
                  </div>

                  {/* Stats Summary */}
                  <div className="flex items-center gap-4 py-2 px-3 bg-surface-800 rounded-lg text-sm">
                    <span className="text-surface-400">
                      {state.selectedCommit.stats.filesChanged} file{state.selectedCommit.stats.filesChanged !== 1 ? 's' : ''} changed
                    </span>
                    {state.selectedCommit.stats.insertions > 0 && (
                      <span className="text-success-400">+{state.selectedCommit.stats.insertions}</span>
                    )}
                    {state.selectedCommit.stats.deletions > 0 && (
                      <span className="text-error-400">-{state.selectedCommit.stats.deletions}</span>
                    )}
                  </div>

                  {/* Changed Files */}
                  <div className="space-y-1">
                    <h4 className="text-sm font-medium text-surface-300 mb-2">Changed Files</h4>
                    {state.selectedCommit.files.map((file) => {
                      const statusColors: Record<string, string> = {
                        added: 'text-success-400 bg-success-400/20',
                        modified: 'text-primary-400 bg-primary-400/20',
                        deleted: 'text-error-400 bg-error-400/20',
                        renamed: 'text-accent-400 bg-accent-400/20',
                        copied: 'text-info-400 bg-info-400/20',
                      };
                      const statusLabels: Record<string, string> = {
                        added: 'A',
                        modified: 'M',
                        deleted: 'D',
                        renamed: 'R',
                        copied: 'C',
                      };

                      return (
                        <button
                          key={file.file}
                          onClick={() => handleViewDiff(file.file, false, state.selectedCommit?.hash)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-700/50 text-left group"
                          title="Click to view diff"
                        >
                          <span className={clsx('w-5 h-5 flex items-center justify-center rounded text-xs font-bold', statusColors[file.status])}>
                            {statusLabels[file.status]}
                          </span>
                          <span className="flex-1 text-sm text-surface-200 font-mono truncate group-hover:text-primary-400">
                            {file.oldPath ? `${file.oldPath} -> ` : ''}{file.file}
                          </span>
                          <span className="text-xs text-surface-500">
                            {file.insertions > 0 && <span className="text-success-400">+{file.insertions}</span>}
                            {file.insertions > 0 && file.deletions > 0 && ' / '}
                            {file.deletions > 0 && <span className="text-error-400">-{file.deletions}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-surface-500">
                  Failed to load commit details
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Diff View Modal */}
      {state.showDiffModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={handleCloseDiffModal}
        >
          <div
            className="w-full max-w-4xl max-h-[85vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                </svg>
                <span className="font-medium text-surface-100">Diff: {state.diffFile}</span>
                {state.diffIsStaged && (
                  <span className="px-2 py-0.5 text-xs bg-success-500/20 text-success-400 rounded">Staged</span>
                )}
                {state.diffCommit && (
                  <span className="px-2 py-0.5 text-xs bg-primary-500/20 text-primary-400 rounded font-mono">
                    {state.diffCommit.substring(0, 7)}
                  </span>
                )}
              </div>
              <button
                onClick={handleCloseDiffModal}
                className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto bg-surface-950">
              {state.isLoadingDiff ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
                </div>
              ) : state.diffContent ? (
                <pre className="p-4 text-xs font-mono overflow-x-auto">
                  {state.diffContent.split('\n').map((line, idx) => {
                    let lineClass = 'text-surface-400';
                    let bgClass = '';

                    if (line.startsWith('+') && !line.startsWith('+++')) {
                      lineClass = 'text-success-400';
                      bgClass = 'bg-success-500/10';
                    } else if (line.startsWith('-') && !line.startsWith('---')) {
                      lineClass = 'text-error-400';
                      bgClass = 'bg-error-500/10';
                    } else if (line.startsWith('@@')) {
                      lineClass = 'text-info-400';
                      bgClass = 'bg-info-500/10';
                    } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
                      lineClass = 'text-surface-500';
                    }

                    return (
                      <div key={idx} className={clsx('px-2 -mx-2', bgClass, lineClass)}>
                        {line || ' '}
                      </div>
                    );
                  })}
                </pre>
              ) : (
                <div className="text-center py-8 text-surface-500">
                  No differences to display
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Checkout Confirmation Modal */}
      {state.showCheckoutConfirmModal && state.pendingCheckoutBranch && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={handleCancelCheckout}
        >
          <div
            className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700 bg-warning-500/10">
              <svg className="w-5 h-5 text-warning-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="font-medium text-surface-100">Uncommitted Changes</span>
            </div>

            {/* Modal Content */}
            <div className="p-4 space-y-4">
              <p className="text-sm text-surface-300">
                You have uncommitted changes that will be lost if you switch to branch{' '}
                <span className="font-mono text-primary-400">{state.pendingCheckoutBranch}</span>.
              </p>

              {/* Summary of changes */}
              <div className="text-xs text-surface-400 space-y-1">
                {state.staged.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-success-400 bg-success-400/20">S</span>
                    <span>{state.staged.length} staged file{state.staged.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {state.unstaged.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-primary-400 bg-primary-400/20">M</span>
                    <span>{state.unstaged.length} modified file{state.unstaged.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>

              <p className="text-xs text-surface-500">
                Consider committing your changes first, or discard them to switch branches.
              </p>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
              <button
                onClick={handleCancelCheckout}
                className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDiscardAndCheckout}
                className="px-4 py-2 text-sm bg-error-500/20 hover:bg-error-500/30 text-error-400 border border-error-500/30 rounded-lg transition-colors"
              >
                Discard Changes & Switch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Merge Modal */}
      {state.showMergeModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showMergeModal: false, mergeBranch: null }))}
        >
          <div
            className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
              <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              <span className="font-medium text-surface-100">Merge Branch</span>
            </div>

            {/* Modal Content */}
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs text-surface-400 mb-1">
                  Merge into <span className="font-mono text-primary-400">{state.branch}</span>
                </label>
                <select
                  value={state.mergeBranch || ''}
                  onChange={(e) => setState(prev => ({ ...prev, mergeBranch: e.target.value || null }))}
                  className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 focus:outline-none focus:border-primary-500"
                >
                  <option value="">Select a branch...</option>
                  {localBranches
                    .filter(b => b.name !== state.branch)
                    .map(b => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-surface-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.mergeOptions.noFf}
                    onChange={(e) => setState(prev => ({
                      ...prev,
                      mergeOptions: { ...prev.mergeOptions, noFf: e.target.checked }
                    }))}
                    className="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
                  />
                  <span>Create merge commit (--no-ff)</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-surface-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.mergeOptions.squash}
                    onChange={(e) => setState(prev => ({
                      ...prev,
                      mergeOptions: { ...prev.mergeOptions, squash: e.target.checked }
                    }))}
                    className="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
                  />
                  <span>Squash commits (--squash)</span>
                </label>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
              <button
                onClick={() => setState(prev => ({ ...prev, showMergeModal: false, mergeBranch: null }))}
                className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleMerge}
                disabled={!state.mergeBranch}
                className="px-4 py-2 text-sm bg-primary-500 hover:bg-primary-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-lg transition-colors"
              >
                Merge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stash Modal */}
      {state.showStashModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showStashModal: false, stashMessage: '' }))}
        >
          <div
            className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
              <svg className="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              <span className="font-medium text-surface-100">Stash Changes</span>
            </div>

            {/* Modal Content */}
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs text-surface-400 mb-1">
                  Stash message (optional)
                </label>
                <input
                  type="text"
                  value={state.stashMessage}
                  onChange={(e) => setState(prev => ({ ...prev, stashMessage: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleStashPush(); }}
                  placeholder="Describe what you're stashing..."
                  className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500"
                  autoFocus
                />
              </div>

              <div className="text-xs text-surface-400 space-y-1">
                <p>This will stash:</p>
                {state.staged.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-success-400 bg-success-400/20">S</span>
                    <span>{state.staged.length} staged file{state.staged.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {state.unstaged.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-primary-400 bg-primary-400/20">M</span>
                    <span>{state.unstaged.length} modified file{state.unstaged.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
              <button
                onClick={() => setState(prev => ({ ...prev, showStashModal: false, stashMessage: '' }))}
                className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleStashPush}
                className="px-4 py-2 text-sm bg-accent-500 hover:bg-accent-600 text-white rounded-lg transition-colors"
              >
                Stash
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tag Modal */}
      {state.showTagModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showTagModal: false, newTagName: '', newTagMessage: '', newTagCommit: '' }))}
        >
          <div
            className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
              <svg className="w-5 h-5 text-warning-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <span className="font-medium text-surface-100">Create Tag</span>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs text-surface-400 mb-1">Tag name</label>
                <input
                  type="text"
                  value={state.newTagName}
                  onChange={(e) => setState(prev => ({ ...prev, newTagName: e.target.value }))}
                  placeholder="v1.0.0"
                  className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-surface-400 mb-1">Message (optional, creates annotated tag)</label>
                <input
                  type="text"
                  value={state.newTagMessage}
                  onChange={(e) => setState(prev => ({ ...prev, newTagMessage: e.target.value }))}
                  placeholder="Release 1.0.0"
                  className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs text-surface-400 mb-1">Commit (optional, defaults to HEAD)</label>
                <input
                  type="text"
                  value={state.newTagCommit}
                  onChange={(e) => setState(prev => ({ ...prev, newTagCommit: e.target.value }))}
                  placeholder="HEAD"
                  className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500 font-mono"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
              <button
                onClick={() => setState(prev => ({ ...prev, showTagModal: false, newTagName: '', newTagMessage: '', newTagCommit: '' }))}
                className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTag}
                disabled={!state.newTagName.trim()}
                className="px-4 py-2 text-sm bg-warning-500 hover:bg-warning-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-lg transition-colors"
              >
                Create Tag
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rebase Modal */}
      {state.showRebaseModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showRebaseModal: false, rebaseBranch: null }))}
        >
          <div
            className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
              <svg className="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="font-medium text-surface-100">Rebase onto Branch</span>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs text-surface-400 mb-1">
                  Rebase <span className="font-mono text-primary-400">{state.branch}</span> onto
                </label>
                <select
                  value={state.rebaseBranch || ''}
                  onChange={(e) => setState(prev => ({ ...prev, rebaseBranch: e.target.value || null }))}
                  className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 focus:outline-none focus:border-primary-500"
                >
                  <option value="">Select a branch...</option>
                  {localBranches
                    .filter(b => b.name !== state.branch)
                    .map(b => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                </select>
              </div>
              <p className="text-xs text-surface-500">
                This will replay your commits on top of the selected branch. May cause conflicts that need to be resolved.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
              <button
                onClick={() => setState(prev => ({ ...prev, showRebaseModal: false, rebaseBranch: null }))}
                className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRebase}
                disabled={!state.rebaseBranch}
                className="px-4 py-2 text-sm bg-accent-500 hover:bg-accent-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-lg transition-colors"
              >
                Rebase
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reflog Modal */}
      {state.showReflogModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showReflogModal: false }))}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="font-medium text-surface-100">Reflog - HEAD History</span>
              </div>
              <button
                onClick={() => setState(prev => ({ ...prev, showReflogModal: false }))}
                className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {state.isLoadingReflog ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
                </div>
              ) : state.reflogEntries.length === 0 ? (
                <div className="text-center py-8 text-surface-500">No reflog entries</div>
              ) : (
                <div className="divide-y divide-surface-800">
                  {state.reflogEntries.map((entry) => (
                    <div key={entry.index} className="group flex items-center gap-3 px-4 py-2 hover:bg-surface-800/50">
                      <span className="text-primary-400 font-mono text-xs">{entry.shortHash}</span>
                      <span className="px-1.5 py-0.5 text-[10px] bg-surface-700 text-surface-400 rounded">{entry.action}</span>
                      <span className="flex-1 text-sm text-surface-200 truncate">{entry.message}</span>
                      <span className="text-xs text-surface-500">{formatRelativeTime(entry.date)}</span>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleResetToReflog(entry.index, false)}
                          className="px-2 py-1 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                          title="Soft reset"
                        >
                          Reset
                        </button>
                        <button
                          onClick={() => handleResetToReflog(entry.index, true)}
                          className="px-2 py-1 text-[10px] bg-error-500/20 hover:bg-error-500/30 text-error-400 rounded"
                          title="Hard reset (discards changes)"
                        >
                          Hard
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* File History Modal */}
      {state.showFileHistoryModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showFileHistoryModal: false, fileHistoryFile: null, fileHistoryCommits: [] }))}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="font-medium text-surface-100">File History</span>
                <span className="text-sm text-surface-400 font-mono truncate">{state.fileHistoryFile}</span>
              </div>
              <button
                onClick={() => setState(prev => ({ ...prev, showFileHistoryModal: false, fileHistoryFile: null, fileHistoryCommits: [] }))}
                className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {state.isLoadingFileHistory ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
                </div>
              ) : state.fileHistoryCommits.length === 0 ? (
                <div className="text-center py-8 text-surface-500">No commits found for this file</div>
              ) : (
                <div className="divide-y divide-surface-800">
                  {state.fileHistoryCommits.map((commit) => (
                    <button
                      key={commit.hash}
                      onClick={() => handleViewDiff(state.fileHistoryFile!, false, commit.hash)}
                      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-surface-800/50 text-left"
                    >
                      <span className="text-primary-400 font-mono text-xs">{commit.shortHash}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-surface-200 truncate">{commit.subject}</div>
                        <div className="text-xs text-surface-500">{commit.author} - {formatRelativeTime(commit.date)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Blame Modal */}
      {state.showBlameModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showBlameModal: false, blameFile: null, blameLines: [] }))}
        >
          <div
            className="w-full max-w-4xl max-h-[85vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-info-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <span className="font-medium text-surface-100">Git Blame</span>
                <span className="text-sm text-surface-400 font-mono truncate">{state.blameFile}</span>
              </div>
              <button
                onClick={() => setState(prev => ({ ...prev, showBlameModal: false, blameFile: null, blameLines: [] }))}
                className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-surface-950">
              {state.isLoadingBlame ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
                </div>
              ) : state.blameLines.length === 0 ? (
                <div className="text-center py-8 text-surface-500">No blame information</div>
              ) : (
                <table className="w-full text-xs font-mono">
                  <tbody>
                    {state.blameLines.map((line, idx) => (
                      <tr key={idx} className="hover:bg-surface-800/50">
                        <td className="px-2 py-0.5 text-surface-500 text-right whitespace-nowrap border-r border-surface-800 w-12">
                          {line.lineNumber}
                        </td>
                        <td className="px-2 py-0.5 text-primary-400 whitespace-nowrap border-r border-surface-800 w-16">
                          {line.hash}
                        </td>
                        <td className="px-2 py-0.5 text-surface-400 whitespace-nowrap border-r border-surface-800 max-w-[120px] truncate">
                          {line.author}
                        </td>
                        <td className="px-2 py-0.5 text-surface-300 whitespace-pre">
                          {line.content}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Branch Modal */}
      {state.showDeleteBranchModal && state.branchToDelete && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
          onClick={() => setState(prev => ({ ...prev, showDeleteBranchModal: false, branchToDelete: null, deleteBranchForce: false }))}
        >
          <div
            className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700 bg-error-500/10">
              <svg className="w-5 h-5 text-error-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span className="font-medium text-surface-100">Delete Branch</span>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-sm text-surface-300">
                Are you sure you want to delete branch{' '}
                <span className="font-mono text-primary-400">{state.branchToDelete}</span>?
              </p>
              <label className="flex items-center gap-2 text-sm text-surface-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.deleteBranchForce}
                  onChange={(e) => setState(prev => ({ ...prev, deleteBranchForce: e.target.checked }))}
                  className="rounded border-surface-600 bg-surface-800 text-error-500 focus:ring-error-500"
                />
                <span>Force delete (even if not merged)</span>
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
              <button
                onClick={() => setState(prev => ({ ...prev, showDeleteBranchModal: false, branchToDelete: null, deleteBranchForce: false }))}
                className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteBranch}
                className="px-4 py-2 text-sm bg-error-500 hover:bg-error-600 text-white rounded-lg transition-colors"
              >
                Delete Branch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// FOLDER PICKER MODAL
// ============================================================================

function FolderPickerModal() {
  const isOpen = useAppStore((s) => s.isFolderPickerOpen);
  const close = useAppStore((s) => s.closeFolderPicker);
  const createTerminal = useTerminalStore((s) => s.createTerminal);

  const [selectedFolder, setSelectedFolder] = React.useState<string | null>(null);
  const [recentProjects, setRecentProjects] = React.useState<Array<{ path: string; name: string }>>([]);

  // Load recent projects
  React.useEffect(() => {
    if (isOpen) {
      window.clausitron.getRecentProjects().then(setRecentProjects);
    }
  }, [isOpen]);

  const handleSelectFolder = async () => {
    const folder = await window.clausitron.selectFolder();
    if (folder) {
      setSelectedFolder(folder);
    }
  };

  const handleStart = async () => {
    if (!selectedFolder) return;

    const name = selectedFolder.split(/[/\\]/).pop() || 'Terminal';
    await createTerminal(selectedFolder, name);
    setSelectedFolder(null);
    close();
  };

  if (!isOpen) return null;

  return (
    <div
      className="modal active"
      onClick={close}
    >
      <div
        className="modal-content modal-medium"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Select Project Folder</h2>
          <button onClick={close} className="modal-close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body folder-picker">
          {/* Open Project + Selected Path - Combined Row */}
          <div className="flex items-stretch gap-2 mb-4">
            {/* Open Project Button */}
            <button
              onClick={handleSelectFolder}
              className="flex items-center gap-2 px-4 py-2.5 bg-surface-800 border border-surface-700 rounded-lg hover:bg-surface-700 hover:border-surface-600 transition-colors flex-shrink-0"
            >
              <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
              </svg>
              <div className="text-sm font-medium text-surface-100">Open Project</div>
            </button>

            {/* Selected Path Display */}
            <div
              className={clsx(
                'flex-1 flex items-center px-4 py-2.5 rounded-lg border min-w-0',
                selectedFolder
                  ? 'bg-primary-500/10 border-primary-500/30'
                  : 'bg-surface-900 border-surface-700'
              )}
            >
              {selectedFolder ? (
                <div className="truncate text-sm text-surface-100">{selectedFolder}</div>
              ) : (
                <div className="text-sm text-surface-500 italic">No folder selected</div>
              )}
            </div>
          </div>

          {/* Recent Projects */}
          {recentProjects.length > 0 && (
            <div className="recent-projects-section">
              <div className="section-header">
                <span className="section-title">Recent Projects</span>
              </div>
              <div className="recent-projects-list">
                {recentProjects.slice(0, 3).map((project) => (
                  <button
                    key={project.path}
                    onClick={() => setSelectedFolder(project.path)}
                    className={clsx(
                      'template-option',
                      selectedFolder === project.path && 'bg-primary-500/20'
                    )}
                  >
                    <span className="template-icon">📁</span>
                    <div className="template-info">
                      <span className="template-label">{project.name}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="modal-footer">
          <button onClick={close} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={!selectedFolder}
            className="btn btn-primary"
          >
            Start Session
          </button>
        </div>
      </div>
    </div>
  );
}
