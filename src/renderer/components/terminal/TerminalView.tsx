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
      <TerminalHeader
        showGitPanel={showGitPanel}
        onToggleGitPanel={() => setShowGitPanel(!showGitPanel)}
        hasActiveSession={hasActiveSession}
      />

      {/* Terminal Content */}
      <div className="flex-1 flex overflow-x-clip overflow-y-auto">
        {hasTerminals ? (
          <>
            {/* Git Panel - Left Position */}
            {showGitPanel && hasActiveSession && gitPanelPosition === 'left' && activeTerminal?.cwd && (
              <GitPanel cwd={activeTerminal.cwd} position="left" />
            )}

            {/* Main Terminal Area */}
            <div className="flex-1 min-w-0 relative bg-surface-950 flex-wrap">
              {terminals.map((terminal) => (
                <div
                  key={terminal.id}
                  className={clsx(
                    'absolute inset-0',
                    // Note: Removed transition-opacity to prevent any interference with XTerm.js cursor rendering.
                    // Transitions on parent containers can cause layout thrashing that affects terminal cursor behavior.
                    terminal.id === activeTerminalId ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
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
                      isActive={terminal.id === activeTerminalId}
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
          <EmptyState
            onNewSession={openFolderPicker}
            onNewTerminal={handleOpenTerminal}
            onOpenTextEditor={openTextEditorPicker}
            onQuickRestart={handleQuickRestart}
          />
        )}
      </div>

      {/* Terminal Footer */}
      <TerminalFooter />

      {/* Folder Picker Modal */}
      <FolderPickerModal />

      {/* Text Editor Picker Modal */}
      <TextEditorPickerModal />
    </div>
  );
}
