// ============================================================================
// CREATE PULL REQUEST MODAL COMPONENT
// ============================================================================

import { useState, useEffect } from 'react';
import type { CreatePRData } from '../../../shared/types/github';

interface CreatePullRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  currentBranch: string;
  defaultBase?: string;
  onCreated?: (prNumber: number, prUrl: string) => void;
}

export default function CreatePullRequestModal({
  isOpen,
  onClose,
  owner,
  repo,
  currentBranch,
  defaultBase = 'main',
  onCreated,
}: CreatePullRequestModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(defaultBase);
  const [draft, setDraft] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load available branches
  useEffect(() => {
    if (isOpen) {
      loadBranches();
      // Set default title from branch name
      const branchTitle = currentBranch
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      setTitle(branchTitle);
    }
  }, [isOpen, currentBranch]);

  const loadBranches = async () => {
    try {
      const result = await window.goodvibes.githubListBranches(owner, repo);
      if (result.success && result.data) {
        setBranches(result.data.map((b: { name: string }) => b.name));
      }
    } catch {
      // Use defaults if loading fails
      setBranches(['main', 'master', 'develop']);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const prData: CreatePRData = {
        title: title.trim(),
        body: body.trim() || undefined,
        head: currentBranch,
        base,
        draft,
      };

      const result = await window.goodvibes.githubCreatePR(owner, repo, prData);

      if (result.success && result.data) {
        onCreated?.(result.data.number, result.data.html_url);
        onClose();
        // Open the PR in browser
        window.open(result.data.html_url, '_blank', 'noopener,noreferrer');
      } else {
        setError(result.error || 'Failed to create pull request');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create pull request');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
      <div
        className="bg-surface-800 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-surface-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-surface-100">Create Pull Request</h2>
          <button
            onClick={onClose}
            className="text-surface-400 hover:text-surface-200"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Branch info */}
          <div className="flex items-center gap-2 text-sm text-surface-400">
            <span className="font-medium text-surface-200">{currentBranch}</span>
            <ArrowIcon className="w-4 h-4" />
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="select text-sm"
            >
              {branches.filter((b: string) => b !== currentBranch).map((branch: string) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Pull request title"
              className="input w-full"
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">
              Description (optional)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Describe your changes..."
              rows={6}
              className="input w-full resize-none"
            />
          </div>

          {/* Draft toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              className="rounded border-surface-600 bg-surface-700 text-primary-500 focus:ring-primary-500"
            />
            <span className="text-sm text-surface-300">Create as draft</span>
          </label>

          {/* Error */}
          {error && (
            <p className="text-sm text-error-400 bg-error-900/20 px-3 py-2 rounded">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || !title.trim()}
            >
              {isSubmitting ? 'Creating...' : draft ? 'Create Draft PR' : 'Create PR'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================================
// ICONS
// ============================================================================

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
    </svg>
  );
}

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
    </svg>
  );
}
