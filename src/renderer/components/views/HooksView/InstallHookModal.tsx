// ============================================================================
// INSTALL HOOK MODAL
// Modal for selecting scope and project when installing built-in hooks
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Globe, FolderOpen, Terminal, Tag } from 'lucide-react';
import { FocusTrap } from '../../common/FocusTrap';
import ProjectSelector from '../../shared/ProjectSelector';
import { EVENT_TYPE_ICONS } from './types';
import { CATEGORY_COLORS, CATEGORY_LABELS, type BuiltinHook } from './builtinHooks';

// ============================================================================
// TYPES
// ============================================================================

interface InstallHookModalProps {
  hook: BuiltinHook;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (hook: BuiltinHook, scope: 'user' | 'project', projectPath: string | null) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function InstallHookModal({
  hook,
  isOpen,
  onClose,
  onInstall,
}: InstallHookModalProps) {
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);

  // Reset state when modal opens with a new hook
  useEffect(() => {
    if (isOpen) {
      setScope('user');
      setSelectedProjectId(null);
      setSelectedProjectPath(null);
    }
  }, [isOpen, hook.id]);

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

  const handleProjectChange = useCallback((projectId: number | null, projectPath: string | null) => {
    setSelectedProjectId(projectId);
    setSelectedProjectPath(projectPath);
  }, []);

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

    onInstall(hook, scope, projectPath);
    onClose();
  }, [hook, scope, selectedProjectPath, onInstall, onClose]);

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
          aria-labelledby="install-hook-modal-title"
          className="bg-surface-900 border border-surface-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 animate-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-surface-700">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-accent-purple/10 rounded-lg">
                <Download className="w-5 h-5 text-accent-purple" />
              </div>
              <div>
                <h2
                  id="install-hook-modal-title"
                  className="text-lg font-medium text-surface-100"
                >
                  Install Hook
                </h2>
                <p className="text-sm text-surface-400">{hook.name}</p>
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
                  <Globe className={`w-5 h-5 ${scope === 'user' ? 'text-accent-purple' : 'text-surface-500'}`} />
                  <div className="text-left">
                    <div className="font-medium">User (Global)</div>
                    <div className="text-xs text-surface-500">Available in all projects</div>
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
                  <FolderOpen className={`w-5 h-5 ${scope === 'project' ? 'text-accent-purple' : 'text-surface-500'}`} />
                  <div className="text-left">
                    <div className="font-medium">Project</div>
                    <div className="text-xs text-surface-500">Only in specific project</div>
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

            {/* Hook Preview */}
            <div className="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-surface-500 uppercase tracking-wider font-medium">
                  Hook Preview
                </span>
              </div>

              <div className="space-y-3">
                {/* Name and Category */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    {EVENT_TYPE_ICONS[hook.eventType]}
                    <span className="font-medium text-surface-200">{hook.name}</span>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${CATEGORY_COLORS[hook.category]}`}>
                    {CATEGORY_LABELS[hook.category]}
                  </span>
                </div>

                {/* Description */}
                <p className="text-sm text-surface-400">{hook.description}</p>

                {/* Details Grid */}
                <div className="grid grid-cols-3 gap-3 pt-2">
                  <div className="bg-surface-900/50 rounded p-2">
                    <span className="text-xs text-surface-500 block">Event</span>
                    <span className="text-sm text-surface-300 font-mono">{hook.eventType}</span>
                  </div>
                  <div className="bg-surface-900/50 rounded p-2">
                    <span className="text-xs text-surface-500 block">Matcher</span>
                    <span className="text-sm text-surface-300 font-mono">{hook.matcher || 'None'}</span>
                  </div>
                  <div className="bg-surface-900/50 rounded p-2">
                    <span className="text-xs text-surface-500 block">Timeout</span>
                    <span className="text-sm text-surface-300 font-mono">{hook.timeout}ms</span>
                  </div>
                </div>

                {/* Type Badge */}
                <div className="flex items-center gap-2 pt-1">
                  <Terminal className="w-3.5 h-3.5 text-surface-500" />
                  <span className="text-xs text-surface-500">
                    {hook.hookType === 'command' ? 'Shell Command' : 'Prompt Hook'}
                  </span>
                </div>

                {/* Tags */}
                {hook.tags.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap pt-1">
                    {hook.tags.slice(0, 4).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface-900 text-surface-500 rounded text-xs"
                      >
                        <Tag className="w-2.5 h-2.5" />
                        {tag}
                      </span>
                    ))}
                    {hook.tags.length > 4 && (
                      <span className="text-xs text-surface-600">
                        +{hook.tags.length - 4} more
                      </span>
                    )}
                  </div>
                )}
              </div>
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
                : 'Install Hook'}
            </button>
          </div>
        </div>
      </FocusTrap>
    </div>,
    document.body
  );
}
