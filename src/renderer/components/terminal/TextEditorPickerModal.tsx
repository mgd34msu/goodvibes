// ============================================================================
// TEXT EDITOR PICKER MODAL - Select folder or file to open in text editor
// ============================================================================

import React, { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { Folder, FileText } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSettingsStore } from '../../stores/settingsStore';

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

export function TextEditorPickerModal(): React.JSX.Element | null {
  const isOpen = useAppStore((s) => s.isTextEditorPickerOpen);
  const close = useAppStore((s) => s.closeTextEditorPicker);
  const createPlainTerminal = useTerminalStore((s) => s.createPlainTerminal);
  const preferredTextEditor = useSettingsStore((s) => s.settings.preferredTextEditor);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isFile, setIsFile] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

  // Load recent projects when modal opens
  useEffect(() => {
    if (isOpen) {
      window.goodvibes.getRecentProjects().then(setRecentProjects);
      setSelectedPath(null);
      setIsFile(false);
    }
  }, [isOpen]);

  const handleSelectFolder = async () => {
    const folder = await window.goodvibes.selectFolder();
    if (folder) {
      setSelectedPath(folder);
      setIsFile(false);
    }
  };

  const handleSelectFile = async () => {
    const file = await window.goodvibes.selectFile();
    if (file) {
      setSelectedPath(file);
      setIsFile(true);
    }
  };

  const handleStart = async () => {
    if (!selectedPath) return;

    // Get the working directory (use file's directory if a file was selected)
    const cwd = isFile ? selectedPath.substring(0, selectedPath.lastIndexOf(selectedPath.includes('/') ? '/' : '\\')) : selectedPath;

    // Start a plain terminal in the selected folder
    const result = await createPlainTerminal(cwd);
    if (result.id !== undefined) {
      // Get the preferred editor or default
      let editor = preferredTextEditor;
      if (!editor) {
        editor = await window.goodvibes.getDefaultEditor();
      }
      if (editor) {
        // Build the editor command
        let command = editor;
        if (isFile) {
          // Open the specific file
          command = `${editor} "${selectedPath}"`;
        }
        // Send the editor command to the terminal
        await window.goodvibes.terminalInput(result.id, `${command}\r`);
      }
    }

    setSelectedPath(null);
    setIsFile(false);
    close();
  };

  const handleClose = () => {
    setSelectedPath(null);
    setIsFile(false);
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
    } else if (e.key === 'Enter' && selectedPath) {
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
      aria-labelledby="text-editor-picker-title"
    >
      <div
        className="modal-content modal-medium"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="text-editor-picker-title">Open in Text Editor</h2>
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
          {/* Open Folder/File Buttons + Selected Path */}
          <div className="flex items-stretch gap-2 mb-4">
            {/* Open Folder Button */}
            <button
              onClick={handleSelectFolder}
              className="flex items-center gap-2 px-4 py-2.5 bg-surface-800 border border-surface-700 rounded-lg hover:bg-surface-700 hover:border-surface-600 transition-colors flex-shrink-0"
            >
              <Folder className="w-5 h-5 text-primary-400" aria-hidden="true" />
              <div className="text-left">
                <div className="text-sm font-medium text-surface-100">Open Folder</div>
              </div>
            </button>

            {/* Open File Button */}
            <button
              onClick={handleSelectFile}
              className="flex items-center gap-2 px-4 py-2.5 bg-surface-800 border border-surface-700 rounded-lg hover:bg-surface-700 hover:border-surface-600 transition-colors flex-shrink-0"
            >
              <FileText className="w-5 h-5 text-warning-400" aria-hidden="true" />
              <div className="text-left">
                <div className="text-sm font-medium text-surface-100">Open File</div>
              </div>
            </button>
          </div>

          {/* Selected Path Display */}
          <div
            className={clsx(
              'flex items-center px-4 py-2.5 rounded-lg border min-w-0 mb-4',
              selectedPath
                ? 'bg-primary-500/10 border-primary-500/30'
                : 'bg-surface-900 border-surface-700'
            )}
            aria-live="polite"
          >
            {selectedPath ? (
              <div className="flex items-center gap-2 min-w-0">
                {isFile ? (
                  <FileText className="w-4 h-4 text-warning-400 flex-shrink-0" aria-hidden="true" />
                ) : (
                  <Folder className="w-4 h-4 text-primary-400 flex-shrink-0" aria-hidden="true" />
                )}
                <div className="truncate text-sm text-surface-100">{selectedPath}</div>
              </div>
            ) : (
              <div className="text-sm text-surface-500 italic">No folder or file selected</div>
            )}
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
                    onClick={() => {
                      setSelectedPath(project.path);
                      setIsFile(false);
                    }}
                    role="option"
                    aria-selected={selectedPath === project.path && !isFile}
                    className={clsx(
                      'template-option',
                      selectedPath === project.path && !isFile && 'bg-primary-500/20'
                    )}
                  >
                    <Folder className="w-5 h-5 text-primary-400" aria-hidden="true" />
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
            disabled={!selectedPath}
            className="btn btn-primary"
          >
            Open Editor
          </button>
        </div>
      </div>
    </div>
  );
}

export default TextEditorPickerModal;
