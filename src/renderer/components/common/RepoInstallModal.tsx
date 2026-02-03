// ============================================================================
// REPOSITORY INSTALL MODAL
// ============================================================================
//
// A reusable modal for installing MCP servers or Plugins from git repositories.
// Accepts GitHub URLs (https://github.com/user/repo) or .git links.
//
// ============================================================================

import { useState, useCallback } from 'react';
import { GitBranch, X, Download, AlertCircle, ExternalLink } from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

export interface RepoInstallModalProps {
  /** Modal title */
  title: string;
  /** Description shown under the title */
  description: string;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Called when the user submits a valid URL */
  onInstall: (repoUrl: string, repoInfo: ParsedRepoInfo) => Promise<void>;
  /** Called when the modal should close */
  onClose: () => void;
  /** Whether an installation is currently in progress */
  isInstalling?: boolean;
}

export interface ParsedRepoInfo {
  /** Repository owner (e.g., 'anthropics') */
  owner: string;
  /** Repository name (e.g., 'claude-code') */
  repo: string;
  /** Full repository URL */
  fullUrl: string;
  /** GitHub shorthand (e.g., 'anthropics/claude-code') */
  shorthand: string;
  /** Optional subdirectory path for monorepo installations */
  subdir?: string;
  /** Optional branch name */
  branch?: string;
}

// ============================================================================
// URL PARSING
// ============================================================================

/**
 * Parse a repository URL into its components.
 * Supports:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch/path/to/subdir
 */
export function parseRepoUrl(url: string): ParsedRepoInfo | null {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return null;

  // GitHub tree URL pattern (monorepo subdirectory)
  const treeMatch = trimmedUrl.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?/
  );
  if (treeMatch) {
    const owner = treeMatch[1];
    const repo = treeMatch[2];
    const branch = treeMatch[3];
    const subdir = treeMatch[4];
    if (!owner || !repo || !branch) return null;
    const cleanRepo = repo.replace(/\.git$/, '');
    return {
      owner,
      repo: cleanRepo,
      fullUrl: `https://github.com/${owner}/${cleanRepo}`,
      shorthand: `${owner}/${cleanRepo}`,
      branch,
      subdir,
    };
  }

  // HTTPS GitHub URL pattern
  const httpsMatch = trimmedUrl.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/\s]+)/
  );
  if (httpsMatch) {
    const owner = httpsMatch[1];
    const repo = httpsMatch[2];
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, '');
    return {
      owner,
      repo: cleanRepo,
      fullUrl: `https://github.com/${owner}/${cleanRepo}`,
      shorthand: `${owner}/${cleanRepo}`,
    };
  }

  // SSH pattern (git@github.com:owner/repo.git)
  const sshMatch = trimmedUrl.match(/git@github\.com:([^/]+)\/([^/\s]+)/);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, '');
    return {
      owner,
      repo: cleanRepo,
      fullUrl: `https://github.com/${owner}/${cleanRepo}`,
      shorthand: `${owner}/${cleanRepo}`,
    };
  }

  // Simple shorthand (owner/repo)
  const shorthandMatch = trimmedUrl.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shorthandMatch) {
    const owner = shorthandMatch[1];
    const repo = shorthandMatch[2];
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, '');
    return {
      owner,
      repo: cleanRepo,
      fullUrl: `https://github.com/${owner}/${cleanRepo}`,
      shorthand: `${owner}/${cleanRepo}`,
    };
  }

  return null;
}

// ============================================================================
// MODAL COMPONENT
// ============================================================================

export function RepoInstallModal({
  title,
  description,
  placeholder = 'https://github.com/user/repository or user/repository',
  onInstall,
  onClose,
  isInstalling = false,
}: RepoInstallModalProps): React.JSX.Element {
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parsedInfo, setParsedInfo] = useState<ParsedRepoInfo | null>(null);

  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    setRepoUrl(url);
    setError(null);

    if (url.trim()) {
      const info = parseRepoUrl(url);
      setParsedInfo(info);
      if (!info) {
        setError('Invalid repository URL format');
      }
    } else {
      setParsedInfo(null);
    }
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (!parsedInfo) {
      setError('Please enter a valid repository URL');
      return;
    }

    try {
      await onInstall(parsedInfo.fullUrl, parsedInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Installation failed');
    }
  }, [parsedInfo, onInstall]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent-purple/10">
              <GitBranch className="w-5 h-5 text-accent-purple" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-surface-100">{title}</h2>
              <p className="text-sm text-surface-400">{description}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* URL Input */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">
              Repository URL
            </label>
            <input
              type="text"
              value={repoUrl}
              onChange={handleUrlChange}
              placeholder={placeholder}
              className="input w-full"
              autoFocus
              disabled={isInstalling}
            />
          </div>

          {/* Parsed Info Preview */}
          {parsedInfo && !error && (
            <div className="p-3 bg-surface-800/50 rounded-lg border border-surface-700/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-accent-purple" />
                  <span className="text-sm font-medium text-surface-200">
                    {parsedInfo.shorthand}
                  </span>
                </div>
                <a
                  href={parsedInfo.fullUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent-purple hover:underline flex items-center gap-1"
                >
                  View on GitHub
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              {parsedInfo.subdir && (
                <p className="text-xs text-surface-400 mt-1">
                  Subdirectory: {parsedInfo.subdir}
                </p>
              )}
              {parsedInfo.branch && (
                <p className="text-xs text-surface-400 mt-1">
                  Branch: {parsedInfo.branch}
                </p>
              )}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-error-500/10 border border-error-500/30 rounded-lg">
              <AlertCircle className="w-4 h-4 text-error-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-error-300">{error}</p>
            </div>
          )}

          {/* Help Text */}
          <div className="text-xs text-surface-500">
            <p className="mb-1">Supported formats:</p>
            <ul className="list-disc list-inside space-y-0.5 text-surface-400">
              <li>https://github.com/user/repository</li>
              <li>https://github.com/user/repository.git</li>
              <li>user/repository (shorthand)</li>
              <li>GitHub monorepo subdirectory URLs</li>
            </ul>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-surface-700">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary"
              disabled={isInstalling}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!parsedInfo || !!error || isInstalling}
              className="btn btn-primary flex items-center gap-2"
            >
              {isInstalling ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Install
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default RepoInstallModal;
