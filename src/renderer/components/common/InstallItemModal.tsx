// ============================================================================
// INSTALL ITEM MODAL (GENERIC)
// Generic modal for selecting scope and project when installing items
// Used by: Agents, Skills, Hooks, Commands
// ============================================================================

import { useState, useEffect, useCallback, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Globe, FolderOpen } from 'lucide-react';
import { FocusTrap } from './FocusTrap';
import ProjectSelector from '../shared/ProjectSelector';

// ============================================================================
// TYPES
// ============================================================================

export interface InstallItemModalProps<T> {
  /** The item to install */
  item: T;
  /** Modal open state */
  isOpen: boolean;
  /** Called when modal closes */
  onClose: () => void;
  /** Called when install button clicked */
  onInstall: (item: T, scope: 'user' | 'project', projectPath: string | null) => void;
  /** Modal title (e.g., "Install Agent", "Install Skill") */
  modalTitle: string;
  /** Item display name shown in header subtitle */
  itemDisplayName: string;
  /** Install button text (e.g., "Install Agent", "Install Skill") */
  installButtonText: string;
  /** Icon to show in header */
  headerIcon: ReactNode;
  /** Preview section title (e.g., "Agent Preview", "Skill Preview") */
  previewTitle: string;
  /** Render function for item-specific preview content */
  renderPreview: (item: T) => ReactNode;
  /** Key to track item changes (e.g., item.name, item.id) */
  itemKey: string | number;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function InstallItemModal<T>({
  item,
  isOpen,
  onClose,
  onInstall,
  modalTitle,
  itemDisplayName,
  installButtonText,
  headerIcon,
  previewTitle,
  renderPreview,
  itemKey,
}: InstallItemModalProps<T>) {
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);

  // Reset state when modal opens with a new item
  useEffect(() => {
    if (isOpen) {
      setScope('user');
      setSelectedProjectId(null);
      setSelectedProjectPath(null);
    }
  }, [isOpen, itemKey]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleProjectChange = useCallback(
    (projectId: number | null, projectPath: string | null) => {
      setSelectedProjectId(projectId);
      setSelectedProjectPath(projectPath);
    },
    []
  );

  const handleInstall = useCallback(async () => {
    let projectPath: string | null = null;

    if (scope === 'project') {
      if (selectedProjectPath) {
        projectPath = selectedProjectPath;
      } else {
        // No project selected, prompt for folder
        const folderPath = await window.goodvibes?.selectFolder?.();
        if (!folderPath) {
          return; // User cancelled
        }
        projectPath = folderPath;
      }
    }

    onInstall(item, scope, projectPath);
    onClose();
  }, [item, scope, selectedProjectPath, onInstall, onClose]);

  // Install button is enabled if:
  // - scope is 'user' (no project needed)
  // - scope is 'project' and a project is selected OR we'll prompt for folder
  const canInstall = scope === 'user' || selectedProjectPath !== null;

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] animate-in fade-in duration-200"
      onClick={onClose}
    >
      <FocusTrap>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-item-modal-title"
          className="bg-surface-900 border border-surface-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 animate-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-surface-700">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-accent-purple/10 rounded-lg">
                {headerIcon}
              </div>
              <div>
                <h2
                  id="install-item-modal-title"
                  className="text-lg font-medium text-surface-100"
                >
                  {modalTitle}
                </h2>
                <p className="text-sm text-surface-400">{itemDisplayName}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-surface-500 hover:text-surface-300 hover:bg-surface-800 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="p-4 space-y-5">
            {/* Scope Selection */}
            <div>
              <label className="block text-sm font-medium text-surface-300 mb-3">
                Installation Scope
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setScope('user');
                    setSelectedProjectId(null);
                    setSelectedProjectPath(null);
                  }}
                  className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-all ${
                    scope === 'user'
                      ? 'border-accent-purple bg-accent-purple/10 text-surface-100'
                      : 'border-surface-700 bg-surface-800/50 text-surface-300 hover:border-surface-600 hover:bg-surface-800'
                  }`}
                >
                  <Globe
                    className={`w-5 h-5 ${
                      scope === 'user' ? 'text-accent-purple' : 'text-surface-500'
                    }`}
                  />
                  <div className="text-left">
                    <div className="font-medium">User (Global)</div>
                    <div className="text-xs text-surface-500">
                      Available in all projects
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setScope('project')}
                  className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-all ${
                    scope === 'project'
                      ? 'border-accent-purple bg-accent-purple/10 text-surface-100'
                      : 'border-surface-700 bg-surface-800/50 text-surface-300 hover:border-surface-600 hover:bg-surface-800'
                  }`}
                >
                  <FolderOpen
                    className={`w-5 h-5 ${
                      scope === 'project' ? 'text-accent-purple' : 'text-surface-500'
                    }`}
                  />
                  <div className="text-left">
                    <div className="font-medium">Project</div>
                    <div className="text-xs text-surface-500">
                      Only in specific project
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* Project Selector (only shown when project scope selected) */}
            {scope === 'project' && (
              <div className="animate-in slide-in-from-top-2 duration-200">
                <ProjectSelector
                  scope={scope}
                  selectedProjectId={selectedProjectId}
                  onProjectChange={handleProjectChange}
                />
              </div>
            )}

            {/* Item Preview */}
            <div className="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-surface-500 uppercase tracking-wider font-medium">
                  {previewTitle}
                </span>
              </div>
              <div className="space-y-3">{renderPreview(item)}</div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 p-4 border-t border-surface-700">
            <button
              onClick={onClose}
              className="px-4 py-2 text-surface-300 hover:text-surface-100 hover:bg-surface-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleInstall}
              disabled={scope === 'project' && !canInstall}
              className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              {scope === 'project' && !selectedProjectPath
                ? 'Choose Folder & Install'
                : installButtonText}
            </button>
          </div>
        </div>
      </FocusTrap>
    </div>,
    document.body
  );
}
