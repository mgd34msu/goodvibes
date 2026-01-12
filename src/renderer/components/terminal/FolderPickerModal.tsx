// ============================================================================
// FOLDER PICKER MODAL - Select project folder for new terminal session
// ============================================================================

import React, { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { useAppStore } from '../../stores/appStore';
import { useTerminalStore } from '../../stores/terminalStore';

// ============================================================================
// TYPES
// ============================================================================

interface RecentProject {
  path: string;
  name: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function FolderPickerModal() {
  const isOpen = useAppStore((s) => s.isFolderPickerOpen);
  const close = useAppStore((s) => s.closeFolderPicker);
  const createTerminal = useTerminalStore((s) => s.createTerminal);

  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

  // Load recent projects when modal opens
  useEffect(() => {
    if (isOpen) {
      window.goodvibes.getRecentProjects().then(setRecentProjects);
    }
  }, [isOpen]);

  const handleSelectFolder = async () => {
    const folder = await window.goodvibes.selectFolder();
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

  const handleClose = () => {
    setSelectedFolder(null);
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
    } else if (e.key === 'Enter' && selectedFolder) {
      handleStart();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="modal active"
      onClick={handleClose}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-picker-title"
    >
      <div
        className="modal-content modal-medium"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="folder-picker-title">Select Project Folder</h2>
          <button
            onClick={handleClose}
            className="modal-close"
            aria-label="Close modal"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
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
              <div className="text-left">
                <div className="text-sm font-medium text-surface-100">Open Project</div>
              </div>
            </button>

            {/* Selected Path Display */}
            <div
              className={clsx(
                'flex-1 flex items-center px-4 py-2.5 rounded-lg border min-w-0',
                selectedFolder
                  ? 'bg-primary-500/10 border-primary-500/30'
                  : 'bg-surface-900 border-surface-700'
              )}
              aria-live="polite"
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
              <div className="recent-projects-list" role="listbox" aria-label="Recent projects">
                {recentProjects.slice(0, 3).map((project) => (
                  <button
                    key={project.path}
                    onClick={() => setSelectedFolder(project.path)}
                    role="option"
                    aria-selected={selectedFolder === project.path}
                    className={clsx(
                      'template-option',
                      selectedFolder === project.path && 'bg-primary-500/20'
                    )}
                  >
                    <span className="template-icon" aria-hidden="true">folder</span>
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
          <button onClick={handleClose} className="btn btn-secondary">
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

export default FolderPickerModal;
