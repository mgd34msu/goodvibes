// ============================================================================
// PROJECT SELECTOR - Reusable component for selecting project scope
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { FolderOpen, AlertTriangle, X } from 'lucide-react';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('ProjectSelector');

// ============================================================================
// TYPES
// ============================================================================

interface RegisteredProject {
  id: number;
  path: string;
  name: string;
  description: string | null;
  lastOpened: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectSelectorProps {
  scope: 'user' | 'project';
  selectedProjectId: number | null;
  onProjectChange: (projectId: number | null, projectPath: string | null) => void;
  disabled?: boolean;
}

// ============================================================================
// ADD PROJECT MODAL
// ============================================================================

interface AddProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectAdded: (project: RegisteredProject) => void;
}

function AddProjectModal({ isOpen, onClose, onProjectAdded }: AddProjectModalProps) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExitWarning, setShowExitWarning] = useState(false);

  const hasChanges = path.trim() !== '' || name.trim() !== '' || description.trim() !== '';

  const handleSelectFolder = async () => {
    try {
      const selectedPath = await window.goodvibes?.selectFolder?.();
      if (selectedPath) {
        setPath(selectedPath);
        // Auto-fill name from folder name if empty
        if (!name) {
          const folderName = selectedPath.split(/[\\/]/).pop() || '';
          setName(folderName);
        }
        setError(null);
      }
    } catch (err) {
      logger.error('Failed to select folder:', err);
    }
  };

  const handleSave = async () => {
    if (!path.trim()) {
      setError('Please select a project folder');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.goodvibes?.projectRegister?.({
        path: path.trim(),
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      });

      if (result) {
        onProjectAdded(result);
        resetForm();
      }
    } catch (err) {
      logger.error('Failed to register project:', err);
      setError(err instanceof Error ? err.message : 'Failed to register project');
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setPath('');
    setName('');
    setDescription('');
    setError(null);
  };

  const handleClose = () => {
    if (hasChanges) {
      setShowExitWarning(true);
    } else {
      resetForm();
      onClose();
    }
  };

  const handleConfirmExit = () => {
    setShowExitWarning(false);
    resetForm();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Main Modal */}
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]" onClick={handleClose}>
        <div
          className="bg-surface-900 border border-surface-700 rounded-lg shadow-xl w-full max-w-lg"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-surface-700">
            <h2 className="text-lg font-medium text-surface-100">Register New Project</h2>
            <button onClick={handleClose} className="text-surface-500 hover:text-surface-300 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-4 space-y-4">
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {/* Folder Selection */}
            <div>
              <label className="block text-sm font-medium text-surface-300 mb-1">
                Project Folder *
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={path}
                  onChange={e => setPath(e.target.value)}
                  placeholder="Select or enter project path..."
                  className="flex-1 px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={handleSelectFolder}
                  className="px-3 py-2 bg-surface-700 text-surface-200 rounded-md hover:bg-surface-600 transition-colors flex items-center gap-2"
                >
                  <FolderOpen className="w-4 h-4" />
                  Browse
                </button>
              </div>
            </div>

            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-surface-300 mb-1">
                Project Name
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Auto-detected from folder name..."
                className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-surface-300 mb-1">
                Description (optional)
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Brief description of this project..."
                rows={2}
                className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 resize-none focus:ring-2 focus:ring-accent-purple focus:border-transparent"
              />
            </div>

            <p className="text-xs text-surface-500">
              Registering a project allows you to save agents, skills, and hooks specific to that project.
              A <code className="bg-surface-800 px-1 rounded">.claude/</code> directory will be created if it doesn't exist.
            </p>
          </div>

          <div className="flex justify-end gap-3 p-4 border-t border-surface-700">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-surface-300 hover:text-surface-100 hover:bg-surface-700 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isLoading || !path.trim()}
              className="px-4 py-2 bg-accent-purple text-white rounded-md hover:bg-accent-purple/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Registering...' : 'Register Project'}
            </button>
          </div>
        </div>
      </div>

      {/* Exit Warning Modal */}
      {showExitWarning && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000]" onClick={() => setShowExitWarning(false)}>
          <div
            className="bg-surface-900 border border-surface-700 rounded-lg shadow-xl w-full max-w-sm p-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-yellow-500/10 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-yellow-500" />
              </div>
              <div>
                <h3 className="font-medium text-surface-100">Discard Changes?</h3>
                <p className="text-sm text-surface-400">You have unsaved changes that will be lost.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowExitWarning(false)}
                className="px-3 py-1.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700 rounded transition-colors"
              >
                Keep Editing
              </button>
              <button
                onClick={handleConfirmExit}
                className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================================
// MAIN PROJECT SELECTOR COMPONENT
// ============================================================================

export default function ProjectSelector({
  scope,
  selectedProjectId,
  onProjectChange,
  disabled = false,
}: ProjectSelectorProps) {
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const result = await window.goodvibes?.projectGetAll?.();
      setProjects(result || []);
    } catch (error) {
      logger.error('Failed to load projects:', error);
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;

    if (value === 'add') {
      setShowAddModal(true);
      return;
    }

    if (value === '' || value === 'select') {
      onProjectChange(null, null);
      return;
    }

    const projectId = parseInt(value, 10);
    const project = projects.find(p => p.id === projectId);
    if (project) {
      onProjectChange(project.id, project.path);
    }
  };

  const handleProjectAdded = (project: RegisteredProject) => {
    setProjects(prev => [...prev, project]);
    onProjectChange(project.id, project.path);
    setShowAddModal(false);
  };

  const handleModalClose = () => {
    setShowAddModal(false);
    // If no project was selected before opening modal, keep it blank
  };

  const isDisabled = disabled || scope === 'user';

  return (
    <>
      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Project
        </label>
        <select
          value={selectedProjectId?.toString() || ''}
          onChange={handleChange}
          disabled={isDisabled}
          className={`w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent ${
            isDisabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {scope === 'user' ? (
            <option value="">User scope (global)</option>
          ) : (
            <>
              <option value="">Select a project...</option>
              {loading ? (
                <option disabled>Loading projects...</option>
              ) : (
                <>
                  {projects.map(project => (
                    <option key={project.id} value={project.id.toString()}>
                      {project.name} ({project.path})
                    </option>
                  ))}
                  <option value="add">+ Add Project...</option>
                </>
              )}
            </>
          )}
        </select>
        {scope === 'project' && !selectedProjectId && (
          <p className="text-xs text-yellow-500 mt-1">
            Select a project or you'll be prompted to choose a folder when saving
          </p>
        )}
      </div>

      <AddProjectModal
        isOpen={showAddModal}
        onClose={handleModalClose}
        onProjectAdded={handleProjectAdded}
      />
    </>
  );
}

// Export the modal separately for reuse
export { AddProjectModal };
export type { RegisteredProject, ProjectSelectorProps };
