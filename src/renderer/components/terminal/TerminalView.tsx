// ============================================================================
// TERMINAL VIEW - Premium main orchestrator component
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAppStore } from '../../stores/appStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { SessionPreviewView } from '../preview/SessionPreviewView';
import { TerminalHeader } from './TerminalHeader';
import { TerminalInstance } from './TerminalInstance';
import { TerminalFooter } from './TerminalFooter';
import { EmptyState } from './EmptyState';
import { FolderPickerModal } from './FolderPickerModal';
import { TextEditorPickerModal } from './TextEditorPickerModal';
import { GitPanel } from '../git';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { TerminalErrorFallback } from './TerminalErrorFallback';

interface RecentSession {
  sessionId: string;
  cwd: string;
  firstPrompt?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function TerminalView() {
  const terminalsMap = useTerminalStore((s) => s.terminals);
  const terminals = useMemo(() => Array.from(terminalsMap.values()), [terminalsMap]);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const zoomLevel = useTerminalStore((s) => s.zoomLevel);
  const createPlainTerminal = useTerminalStore((s) => s.createPlainTerminal);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const gitPanelPosition = useSettingsStore((s) => s.settings.gitPanelPosition);
  const projectsRoot = useSettingsStore((s) => s.settings.projectsRoot);

  const openFolderPicker = useAppStore((s) => s.openFolderPicker);
  const openTextEditorPicker = useAppStore((s) => s.openTextEditorPicker);

  const [recentSession, setRecentSession] = useState<RecentSession | null>(null);

  // Default to showing git panel when there's an active terminal session
  const [showGitPanel, setShowGitPanel] = useState(true);

  // Load most recent session for quick restart
  useEffect(() => {
    window.goodvibes.getMostRecentSession().then(session => {
      if (session) {
        setRecentSession({
          sessionId: session.sessionId,
          cwd: session.cwd,
          firstPrompt: session.firstPrompt,
        });
      }
    }).catch(() => {
      // Ignore errors
    });
  }, []);

  // Handle focus management on mount
  // On mount: if terminals exist but none is active, activate the first one
  useEffect(() => {
    // On mount: activate first terminal if none is active
    if (terminals.length > 0 && activeTerminalId === null) {
      const firstTerminal = terminals[0];
      if (firstTerminal) {
        setActiveTerminal(firstTerminal.id);
      }
    }
    // NOTE: Removed cleanup that was setting activeTerminalId to null on unmount
    // This was causing preview terminals to become invisible when the view switched
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasTerminals = terminals.length > 0;
  const activeTerminal = activeTerminalId ? terminalsMap.get(activeTerminalId) : undefined;
  const hasActiveSession = hasTerminals && activeTerminal && !activeTerminal.isPreview;

  // Handler for opening a plain terminal in project root or most recent project
  const handleOpenTerminal = useCallback(async () => {
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

  // Handler for quick restart of most recent session
  const handleQuickRestart = useCallback(async () => {
    if (recentSession) {
      await createTerminal(recentSession.cwd, undefined, recentSession.sessionId);
    }
  }, [createTerminal, recentSession]);

  return (
    <div className="flex flex-col h-full bg-surface-950">
      {/* Terminal Header */}
      <ErrorBoundary
        fallback={
          <div className="panel-header flex items-center gap-4 px-4 py-3">
            <div className="flex items-center gap-2 text-error-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-sm">Tab bar error - please reload</span>
            </div>
          </div>
        }
      >
        <TerminalHeader
          showGitPanel={showGitPanel}
          onToggleGitPanel={() => setShowGitPanel(!showGitPanel)}
          hasActiveSession={hasActiveSession}
        />
      </ErrorBoundary>

      {/* Terminal Content */}
      <div className="flex-1 flex overflow-hidden">
        {hasTerminals ? (
          <>
            {/* Git Panel - Left Position */}
            {showGitPanel && hasActiveSession && gitPanelPosition === 'left' && activeTerminal?.cwd && (
              <GitPanel cwd={activeTerminal.cwd} position="left" />
            )}

            {/* Main Terminal Area */}
            <div className="flex-1 min-w-0 relative bg-surface-950 overflow-hidden">
              {terminals.map((terminal) => {
                const isActive = terminal.id === activeTerminalId;
                // Preview terminals should be visible when they're the only terminal or when active
                const shouldShow = isActive || (terminal.isPreview && terminals.length === 1);
                return (
                <div
                  key={terminal.id}
                  className={clsx(
                    'absolute inset-0',
                    // Note: Removed transition-opacity to prevent any interference with XTerm.js cursor rendering.
                    // Transitions on parent containers can cause layout thrashing that affects terminal cursor behavior.
                    shouldShow ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
                  )}
                >
                  <ErrorBoundary
                    fallbackRender={({ error, resetErrorBoundary }) => (
                      <TerminalErrorFallback
                        error={error}
                        terminalId={terminal.id}
                        terminalName={terminal.name}
                        onRetry={resetErrorBoundary}
                      />
                    )}
                    resetKeys={[terminal.id]}
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
                        isActive={terminal.id === activeTerminalId}
                        isPlainTerminal={terminal.isPlainTerminal}
                      />
                    )}
                  </ErrorBoundary>
                </div>
              );
              })}
            </div>

            {/* Git Panel - Right Position */}
            {showGitPanel && hasActiveSession && gitPanelPosition === 'right' && activeTerminal?.cwd && (
              <GitPanel cwd={activeTerminal.cwd} position="right" />
            )}
          </>
        ) : (
          <EmptyState
            onNewSession={openFolderPicker}
            onNewTerminal={handleOpenTerminal}
            onOpenTextEditor={openTextEditorPicker}
            onQuickRestart={handleQuickRestart}
          />
        )}
      </div>

      {/* Terminal Footer */}
      <ErrorBoundary
        fallback={
          <div className="footer-premium flex items-center justify-center px-4 py-2.5">
            <span className="text-xs text-surface-500">Footer unavailable</span>
          </div>
        }
      >
        <TerminalFooter />
      </ErrorBoundary>

      {/* Folder Picker Modal */}
      <FolderPickerModal />

      {/* Text Editor Picker Modal */}
      <TextEditorPickerModal />
    </div>
  );
}
