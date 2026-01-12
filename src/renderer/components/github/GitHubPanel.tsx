// ============================================================================
// GITHUB PANEL COMPONENT
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import type { GitHubUser, GitHubRemoteInfo, GitHubCheckRun, GitHubCombinedStatus, GitHubRepository, GitHubOrganization } from '../../../shared/types/github';
import GitHubAuthButton from './GitHubAuthButton';
import PullRequestList from './PullRequestList';
import IssueList from './IssueList';
import CreatePullRequestModal from './CreatePullRequestModal';
import CIStatusBadge, { CombinedStatusBadge } from './CIStatusBadge';

interface GitHubPanelProps {
  cwd: string;
  currentBranch?: string;
  className?: string;
}

export default function GitHubPanel({
  cwd,
  currentBranch,
  className,
}: GitHubPanelProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [repoInfo, setRepoInfo] = useState<GitHubRemoteInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreatePR, setShowCreatePR] = useState(false);
  const [activeTab, setActiveTab] = useState<'prs' | 'issues' | 'ci'>('prs');
  const [ciStatus, setCIStatus] = useState<{
    checks: GitHubCheckRun[];
    combined: GitHubCombinedStatus | null;
  }>({ checks: [], combined: null });
  const [ciLoading, setCILoading] = useState(false);

  // State for repo selector (when no remote)
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);
  const [repos, setRepos] = useState<GitHubRepository[]>([]);
  const [orgs, setOrgs] = useState<GitHubOrganization[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [addingRemote, setAddingRemote] = useState(false);

  // State for create repo modal
  const [showCreateRepoModal, setShowCreateRepoModal] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowRepoDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load auth state and repo info on mount
  useEffect(() => {
    loadAuthState();
  }, []);

  // Load repo info when cwd changes
  useEffect(() => {
    if (isAuthenticated && cwd) {
      loadRepoInfo();
    }
  }, [cwd, isAuthenticated]);

  // Load CI status when branch changes
  useEffect(() => {
    if (repoInfo && currentBranch) {
      loadCIStatus();
    }
  }, [repoInfo, currentBranch]);

  const loadAuthState = async () => {
    try {
      const state = await window.goodvibes.githubGetAuthState();
      setIsAuthenticated(state.isAuthenticated);
      setUser(state.user);

      // If authenticated and we have a cwd, immediately load repo info
      // This ensures we don't show "No GitHub remote" when one exists
      if (state.isAuthenticated && cwd) {
        await loadRepoInfo();
      }
    } catch (err) {
      console.error('Failed to load GitHub auth state:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadRepoInfo = async () => {
    if (!cwd) return;

    setError(null);

    try {
      // Get remotes from git
      const remotesResult = await window.goodvibes.gitRemotes(cwd);
      if (!remotesResult.success || !remotesResult.remotes || remotesResult.remotes.length === 0) {
        setRepoInfo(null);
        return;
      }

      // Find origin or first remote
      const remote = remotesResult.remotes.find((r: { name: string }) => r.name === 'origin') || remotesResult.remotes[0];

      // Parse the remote URL
      const parseResult = await window.goodvibes.githubParseRemote(remote.fetchUrl);

      if (parseResult && parseResult.isGitHub) {
        setRepoInfo({
          ...parseResult,
          remoteName: remote.name,
          remoteUrl: remote.fetchUrl,
        });
      } else {
        setRepoInfo(null);
      }
    } catch (err) {
      console.error('Failed to load repo info:', err);
      setRepoInfo(null);
    }
  };

  const loadCIStatus = async () => {
    if (!repoInfo || !currentBranch) return;

    setCILoading(true);

    try {
      const [checksResult, statusResult] = await Promise.all([
        window.goodvibes.githubGetChecks(repoInfo.owner, repoInfo.repo, currentBranch),
        window.goodvibes.githubGetCommitStatus(repoInfo.owner, repoInfo.repo, currentBranch),
      ]);

      setCIStatus({
        checks: checksResult.success ? checksResult.data || [] : [],
        combined: statusResult.success ? statusResult.data || null : null,
      });
    } catch (err) {
      console.error('Failed to load CI status:', err);
    } finally {
      setCILoading(false);
    }
  };

  // Load user repos and orgs for the dropdown
  const loadUserRepos = async () => {
    if (reposLoading) return;

    setReposLoading(true);
    try {
      const [reposResult, orgsResult] = await Promise.all([
        window.goodvibes.githubListRepos({ sort: 'pushed', per_page: 100 }),
        window.goodvibes.githubListOrgs(),
      ]);

      if (reposResult.success && reposResult.data) {
        setRepos(reposResult.data);
      }
      if (orgsResult.success && orgsResult.data) {
        setOrgs(orgsResult.data);
      }
    } catch (err) {
      console.error('Failed to load repos:', err);
    } finally {
      setReposLoading(false);
    }
  };

  // Load org repos when an org is selected
  const loadOrgRepos = async (org: string) => {
    setReposLoading(true);
    setSelectedOrg(org);
    try {
      const result = await window.goodvibes.githubListOrgRepos(org, { sort: 'pushed', per_page: 100 });
      if (result.success && result.data) {
        setRepos(result.data);
      }
    } catch (err) {
      console.error('Failed to load org repos:', err);
    } finally {
      setReposLoading(false);
    }
  };

  // Add a GitHub repo as the origin remote
  const handleSelectRepo = async (repo: GitHubRepository) => {
    setAddingRemote(true);
    setError(null);

    try {
      // First check if origin remote already exists
      const remotesResult = await window.goodvibes.gitRemotes(cwd);
      const originExists = remotesResult.success &&
        remotesResult.remotes?.some((r: { name: string }) => r.name === 'origin');

      if (originExists) {
        // Remote already exists - just refresh the repo info to show the panel
        await loadRepoInfo();
        setShowRepoDropdown(false);
        return;
      }

      // Add the remote
      const result = await window.goodvibes.gitRemoteAdd(cwd, 'origin', repo.clone_url);

      if (result.success) {
        // Reload repo info to pick up the new remote
        await loadRepoInfo();
        setShowRepoDropdown(false);
      } else {
        // If it failed because remote already exists, still try to load repo info
        if (result.error?.includes('already exists')) {
          await loadRepoInfo();
          setShowRepoDropdown(false);
        } else {
          setError(result.error || 'Failed to add remote');
        }
      }
    } catch (err) {
      console.error('Failed to add remote:', err);
      setError('Failed to add remote');
    } finally {
      setAddingRemote(false);
    }
  };

  // Handle new repo created
  const handleRepoCreated = async (repo: GitHubRepository) => {
    setShowCreateRepoModal(false);
    // Add it as remote automatically
    await handleSelectRepo(repo);
  };

  const handleAuthChange = useCallback((authenticated: boolean, authUser: GitHubUser | null) => {
    setIsAuthenticated(authenticated);
    setUser(authUser);
    if (authenticated && cwd) {
      loadRepoInfo();
    } else {
      setRepoInfo(null);
    }
  }, [cwd]);

  const handlePRCreated = useCallback((prNumber: number, prUrl: string) => {
    // Refresh PR list or show success message
    console.log(`PR #${prNumber} created: ${prUrl}`);
  }, []);

  // Open the dropdown and load repos
  const handleOpenRepoDropdown = () => {
    setShowRepoDropdown(true);
    setSelectedOrg(null);
    loadUserRepos();
  };

  if (isLoading) {
    return (
      <div className={clsx('p-4', className)}>
        <div className="flex items-center gap-2 text-surface-400">
          <SpinnerIcon className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading GitHub...</span>
        </div>
      </div>
    );
  }

  // Not authenticated
  if (!isAuthenticated) {
    return (
      <div className={clsx('p-4 space-y-4', className)}>
        <div className="flex items-center gap-2">
          <GitHubIcon className="w-5 h-5 text-surface-400" />
          <h3 className="text-sm font-medium text-surface-300">GitHub Integration</h3>
        </div>
        <p className="text-sm text-surface-500">
          Connect your GitHub account to view PRs, issues, and CI status.
        </p>
        <GitHubAuthButton onAuthChange={handleAuthChange} showUserInfo={false} />
      </div>
    );
  }

  // Authenticated but no GitHub remote - show repo selector
  if (!repoInfo) {
    return (
      <div className={clsx('p-4 space-y-4', className)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitHubIcon className="w-5 h-5 text-surface-400" />
            <h3 className="text-sm font-medium text-surface-300">GitHub</h3>
          </div>
          {user && (
            <div className="flex items-center gap-2">
              <img
                src={user.avatar_url}
                alt={user.login}
                className="w-5 h-5 rounded-full bg-surface-700"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <span className="text-xs text-surface-400">{user.login}</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <p className="text-sm text-surface-500">
            No GitHub remote configured. Add one to enable PRs, issues, and CI status.
          </p>

          {error && (
            <div className="text-xs text-error-400 bg-error-500/10 px-3 py-2 rounded">
              {error}
            </div>
          )}

          {/* Repository Selector */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={handleOpenRepoDropdown}
              disabled={addingRemote}
              className="w-full flex items-center justify-between px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg hover:border-surface-600 transition-colors"
            >
              <span className="text-surface-300">
                {addingRemote ? 'Adding remote...' : 'Select repository'}
              </span>
              <ChevronDownIcon className="w-4 h-4 text-surface-400" />
            </button>

            {showRepoDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-surface-800 border border-surface-700 rounded-lg shadow-lg z-[9959] max-h-80 overflow-hidden">
                {/* Create new repo option */}
                <button
                  onClick={() => {
                    setShowRepoDropdown(false);
                    setShowCreateRepoModal(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-primary-400 hover:bg-surface-700 border-b border-surface-700"
                >
                  <PlusIcon className="w-4 h-4" />
                  Create new repository
                </button>

                {/* Org/User tabs */}
                <div className="flex border-b border-surface-700">
                  <button
                    onClick={() => {
                      setSelectedOrg(null);
                      loadUserRepos();
                    }}
                    className={clsx(
                      'flex-1 px-3 py-2 text-xs font-medium transition-colors',
                      !selectedOrg
                        ? 'text-primary-400 border-b-2 border-primary-400'
                        : 'text-surface-400 hover:text-surface-200'
                    )}
                  >
                    Your Repos
                  </button>
                  {orgs.length > 0 && (
                    <div className="flex-1 relative group">
                      <button
                        className={clsx(
                          'w-full px-3 py-2 text-xs font-medium transition-colors',
                          selectedOrg
                            ? 'text-primary-400 border-b-2 border-primary-400'
                            : 'text-surface-400 hover:text-surface-200'
                        )}
                      >
                        Organizations
                      </button>
                      <div className="hidden group-hover:block absolute top-full left-0 right-0 bg-surface-800 border border-surface-700 rounded shadow-lg z-[9959]">
                        {orgs.map((org) => (
                          <button
                            key={org.id}
                            onClick={() => loadOrgRepos(org.login)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-surface-300 hover:bg-surface-700"
                          >
                            <img
                              src={org.avatar_url}
                              alt={org.login}
                              className="w-4 h-4 rounded bg-surface-600"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                              }}
                            />
                            {org.login}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Repo list */}
                <div className="max-h-60 overflow-y-auto">
                  {reposLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <SpinnerIcon className="w-4 h-4 animate-spin text-surface-400" />
                    </div>
                  ) : repos.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-surface-500 text-center">
                      No repositories found
                    </div>
                  ) : (
                    repos.map((repo) => (
                      <button
                        key={repo.id}
                        onClick={() => handleSelectRepo(repo)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:bg-surface-700"
                      >
                        {repo.private ? (
                          <LockIcon className="w-4 h-4 text-surface-500 flex-shrink-0" />
                        ) : (
                          <RepoIcon className="w-4 h-4 text-surface-500 flex-shrink-0" />
                        )}
                        <span className="truncate">{repo.full_name}</span>
                        {repo.language && (
                          <span className="ml-auto text-xs text-surface-500">
                            {repo.language}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Logout button at bottom */}
        <div className="pt-2 border-t border-surface-700">
          <GitHubAuthButton
            onAuthChange={handleAuthChange}
            showUserInfo={false}
            className="scale-90"
          />
        </div>

        {/* Create Repo Modal */}
        {showCreateRepoModal && (
          <CreateRepositoryModal
            isOpen={showCreateRepoModal}
            onClose={() => setShowCreateRepoModal(false)}
            onCreated={handleRepoCreated}
            defaultName={cwd.split(/[/\\]/).pop() || ''}
          />
        )}
      </div>
    );
  }

  return (
    <div className={clsx('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-surface-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitHubIcon className="w-4 h-4 text-surface-400" />
            <a
              href={`https://github.com/${repoInfo.owner}/${repoInfo.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-surface-200 hover:text-primary-400"
            >
              {repoInfo.owner}/{repoInfo.repo}
            </a>
          </div>
          {user && (
            <div className="flex items-center gap-1.5">
              <img
                src={user.avatar_url}
                alt={user.login}
                className="w-5 h-5 rounded-full bg-surface-700"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </div>
          )}
        </div>

        {/* Branch CI Status */}
        {currentBranch && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-surface-500">Branch:</span>
            <span className="text-xs font-medium text-surface-300">{currentBranch}</span>
            {ciLoading ? (
              <SpinnerIcon className="w-3 h-3 animate-spin text-surface-500" />
            ) : ciStatus.checks.length > 0 ? (
              <CombinedStatusBadge
                state={getCombinedState(ciStatus.checks)}
                totalCount={ciStatus.checks.length}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-surface-700">
        <TabButton
          active={activeTab === 'prs'}
          onClick={() => setActiveTab('prs')}
        >
          Pull Requests
        </TabButton>
        <TabButton
          active={activeTab === 'issues'}
          onClick={() => setActiveTab('issues')}
        >
          Issues
        </TabButton>
        <TabButton
          active={activeTab === 'ci'}
          onClick={() => setActiveTab('ci')}
        >
          CI/CD
        </TabButton>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto py-2">
        {activeTab === 'prs' && (
          <PullRequestList
            owner={repoInfo.owner}
            repo={repoInfo.repo}
            currentBranch={currentBranch}
            onCreatePR={() => setShowCreatePR(true)}
          />
        )}
        {activeTab === 'issues' && (
          <IssueList
            owner={repoInfo.owner}
            repo={repoInfo.repo}
          />
        )}
        {activeTab === 'ci' && (
          <CIStatusPanel
            checks={ciStatus.checks}
            combined={ciStatus.combined}
            loading={ciLoading}
            onRefresh={loadCIStatus}
          />
        )}
      </div>

      {/* Create PR Modal */}
      {showCreatePR && currentBranch && (
        <CreatePullRequestModal
          isOpen={showCreatePR}
          onClose={() => setShowCreatePR(false)}
          owner={repoInfo.owner}
          repo={repoInfo.repo}
          currentBranch={currentBranch}
          onCreated={handlePRCreated}
        />
      )}
    </div>
  );
}

// ============================================================================
// CREATE REPOSITORY MODAL
// ============================================================================

interface CreateRepositoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (repo: GitHubRepository) => void;
  defaultName?: string;
}

function CreateRepositoryModal({
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
        auto_init: false, // Don't init since we're adding to existing project
      });

      if (result.success && result.data) {
        onCreated(result.data);
      } else {
        setError(result.error || 'Failed to create repository');
      }
    } catch (err) {
      console.error('Failed to create repo:', err);
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

// ============================================================================
// CI STATUS PANEL
// ============================================================================

interface CIStatusPanelProps {
  checks: GitHubCheckRun[];
  combined: GitHubCombinedStatus | null;
  loading: boolean;
  onRefresh: () => void;
}

function CIStatusPanel({ checks, loading, onRefresh }: CIStatusPanelProps) {
  if (loading) {
    return (
      <div className="p-4">
        <div className="flex items-center gap-2 text-surface-400">
          <SpinnerIcon className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading CI status...</span>
        </div>
      </div>
    );
  }

  if (checks.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-surface-500">No CI checks found for this branch.</p>
        <button
          onClick={onRefresh}
          className="mt-2 text-xs text-primary-400 hover:text-primary-300"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-surface-300">
          Checks ({checks.length})
        </h3>
        <button
          onClick={onRefresh}
          className="text-xs text-primary-400 hover:text-primary-300"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-1">
        {checks.map((check) => (
          <button
            key={check.id}
            onClick={() => check.html_url && window.open(check.html_url, '_blank', 'noopener,noreferrer')}
            className="w-full p-2 rounded text-left hover:bg-surface-700/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <CIStatusBadge
                status={check.status}
                conclusion={check.conclusion}
                showLabel={false}
              />
              <span className="text-sm text-surface-200 truncate">{check.name}</span>
              {check.app && (
                <span className="text-xs text-surface-500 ml-auto">{check.app.name}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// TAB BUTTON
// ============================================================================

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
        active
          ? 'text-primary-400 border-primary-400'
          : 'text-surface-400 border-transparent hover:text-surface-200'
      )}
    >
      {children}
    </button>
  );
}

// ============================================================================
// UTILITIES
// ============================================================================

function getCombinedState(checks: GitHubCheckRun[]): 'failure' | 'pending' | 'success' {
  const hasInProgress = checks.some((c) => c.status === 'in_progress' || c.status === 'queued');
  const hasFailed = checks.some((c) => c.conclusion === 'failure');
  const allSuccess = checks.every(
    (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral')
  );

  if (hasFailed) return 'failure';
  if (hasInProgress) return 'pending';
  if (allSuccess) return 'success';
  return 'pending';
}

// ============================================================================
// ICONS
// ============================================================================

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
      />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2a6 6 0 00-6 6h1.5a4.5 4.5 0 014.5-4.5V2z" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

function RepoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
