// ============================================================================
// GITHUB PANEL COMPONENT
// ============================================================================

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import type { GitHubUser, GitHubRepository } from '../../../../shared/types/github';
import GitHubAuthButton from '../GitHubAuthButton';
import PullRequestList from '../PullRequestList';
import IssueList from '../IssueList';
import CreatePullRequestModal from '../CreatePullRequestModal';
import { CombinedStatusBadge } from '../CIStatusBadge';
import { createLogger } from '../../../../shared/logger';
import { GitHubIcon, SpinnerIcon } from './icons';
import { useGitHubAuth, useRepoInfo, useCIStatus, useRepoSelector } from './hooks';
import { getCombinedState } from './utils';
import { CIStatusPanel } from './CIStatusPanel';
import { TabButton } from './TabButton';
import { RepoSelector } from './RepoSelector';
import { CreateRepositoryModal } from './CreateRepositoryModal';

const logger = createLogger('GitHubPanel');

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
  const [showCreatePR, setShowCreatePR] = useState(false);
  const [activeTab, setActiveTab] = useState<'prs' | 'issues' | 'ci'>('prs');
  const [showCreateRepoModal, setShowCreateRepoModal] = useState(false);

  const { isAuthenticated, user, isLoading, handleAuthChange } = useGitHubAuth(cwd);
  const { repoInfo, error, loadRepoInfo, setRepoInfo } = useRepoInfo(cwd, isAuthenticated);
  const { ciStatus, ciLoading, loadCIStatus } = useCIStatus(repoInfo, currentBranch);

  const repoSelector = useRepoSelector(cwd, loadRepoInfo);

  const handleAuthChangeWithRepoRefresh = useCallback((authenticated: boolean, authUser: GitHubUser | null) => {
    handleAuthChange(authenticated, authUser);
    if (authenticated && cwd) {
      loadRepoInfo();
    } else {
      setRepoInfo(null);
    }
  }, [cwd, handleAuthChange, loadRepoInfo, setRepoInfo]);

  const handlePRCreated = useCallback((prNumber: number, prUrl: string) => {
    logger.info(`PR #${prNumber} created: ${prUrl}`);
  }, []);

  const handleRepoCreated = async (repo: GitHubRepository) => {
    setShowCreateRepoModal(false);
    await repoSelector.handleSelectRepo(repo);
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
        <GitHubAuthButton onAuthChange={handleAuthChangeWithRepoRefresh} showUserInfo={false} />
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

          {(error || repoSelector.error) && (
            <div className="text-xs text-error-400 bg-error-500/10 px-3 py-2 rounded">
              {error || repoSelector.error}
            </div>
          )}

          <RepoSelector
            showRepoDropdown={repoSelector.showRepoDropdown}
            repos={repoSelector.repos}
            orgs={repoSelector.orgs}
            reposLoading={repoSelector.reposLoading}
            selectedOrg={repoSelector.selectedOrg}
            addingRemote={repoSelector.addingRemote}
            dropdownRef={repoSelector.dropdownRef}
            onOpenDropdown={repoSelector.handleOpenRepoDropdown}
            onSelectRepo={repoSelector.handleSelectRepo}
            onSelectOrg={repoSelector.loadOrgRepos}
            onLoadUserRepos={repoSelector.loadUserRepos}
            onCreateNewRepo={() => {
              repoSelector.setShowRepoDropdown(false);
              setShowCreateRepoModal(true);
            }}
          />
        </div>

        {/* Logout button at bottom */}
        <div className="pt-2 border-t border-surface-700">
          <GitHubAuthButton
            onAuthChange={handleAuthChangeWithRepoRefresh}
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
