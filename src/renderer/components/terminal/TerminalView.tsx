// ============================================================================
// TERMINAL VIEW - Main orchestrator component (<200 lines)
// ============================================================================

import { useCallback, useMemo, useState } from 'react';
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
import { GitPanel } from '../git';

// ============================================================================
// COMPONENT
// ============================================================================

export default function TerminalView() {
  const terminalsMap = useTerminalStore((s) => s.terminals);
  const terminals = useMemo(() => Array.from(terminalsMap.values()), [terminalsMap]);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const zoomLevel = useTerminalStore((s) => s.zoomLevel);
  const createPlainTerminal = useTerminalStore((s) => s.createPlainTerminal);
  const gitPanelPosition = useSettingsStore((s) => s.settings.gitPanelPosition);
  const projectsRoot = useSettingsStore((s) => s.settings.projectsRoot);

  const openFolderPicker = useAppStore((s) => s.openFolderPicker);

  // Default to showing git panel when there's an active terminal session
  const [showGitPanel, setShowGitPanel] = useState(true);

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
          />
        )}
      </div>

      {/* Terminal Footer */}
      <TerminalFooter />

      {/* Folder Picker Modal */}
      <FolderPickerModal />
    </div>
  );
}
