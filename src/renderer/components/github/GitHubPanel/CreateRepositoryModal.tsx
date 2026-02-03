// ============================================================================
// CREATE REPOSITORY MODAL COMPONENT
// ============================================================================

import { useState } from 'react';
import type { GitHubRepository } from '../../../../shared/types/github';
import { XIcon } from './icons';
import { createLogger } from '../../../../shared/logger';

const logger = createLogger('GitHubPanel');

interface CreateRepositoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (repo: GitHubRepository) => void;
  defaultName?: string;
}

export function CreateRepositoryModal({
  isOpen,
  onClose,
  onCreated,
  defaultName = '',
}: CreateRepositoryModalProps) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Repository name is required');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const result = await window.goodvibes.githubCreateRepo(name.trim(), {
        description: description.trim() || undefined,
        private: isPrivate,
        auto_init: false,
      });

      if (result.success && result.data) {
        onCreated(result.data);
      } else {
        setError(result.error || 'Failed to create repository');
      }
    } catch (err) {
      logger.error('Failed to create repo:', err);
      setError('Failed to create repository');
    } finally {
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
      <div className="bg-surface-800 rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <h3 className="text-sm font-medium text-surface-200">Create New Repository</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-surface-700 text-surface-400"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="text-xs text-error-400 bg-error-500/10 px-3 py-2 rounded">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-surface-400 mb-1">
              Repository name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
              className="w-full px-3 py-2 text-sm bg-surface-900 border border-surface-700 rounded-lg focus:outline-none focus:border-primary-500 text-surface-200"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-surface-400 mb-1">
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A short description of your project"
              className="w-full px-3 py-2 text-sm bg-surface-900 border border-surface-700 rounded-lg focus:outline-none focus:border-primary-500 text-surface-200"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className="rounded border-surface-600 text-primary-500 focus:ring-primary-500"
              />
              <span className="text-sm text-surface-300">Private repository</span>
            </label>
            <p className="text-xs text-surface-500 mt-1 ml-6">
              {isPrivate
                ? 'Only you and collaborators can see this repository'
                : 'Anyone can see this repository'}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700">
          <button
            onClick={onClose}
            className="btn btn-secondary btn-sm"
            disabled={isCreating}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="btn btn-primary btn-sm"
            disabled={isCreating || !name.trim()}
          >
            {isCreating ? 'Creating...' : 'Create repository'}
          </button>
        </div>
      </div>
    </div>
  );
}
