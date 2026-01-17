// ============================================================================
// REPO SELECTOR COMPONENT
// ============================================================================

import { clsx } from 'clsx';
import type { GitHubRepository, GitHubOrganization } from '../../../../shared/types/github';
import { ChevronDownIcon, PlusIcon, LockIcon, RepoIcon, SpinnerIcon } from './icons';

interface RepoSelectorProps {
  showRepoDropdown: boolean;
  repos: GitHubRepository[];
  orgs: GitHubOrganization[];
  reposLoading: boolean;
  selectedOrg: string | null;
  addingRemote: boolean;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  onOpenDropdown: () => void;
  onSelectRepo: (repo: GitHubRepository) => void;
  onSelectOrg: (org: string) => void;
  onLoadUserRepos: () => void;
  onCreateNewRepo: () => void;
}

export function RepoSelector({
  showRepoDropdown,
  repos,
  orgs,
  reposLoading,
  selectedOrg,
  addingRemote,
  dropdownRef,
  onOpenDropdown,
  onSelectRepo,
  onSelectOrg,
  onLoadUserRepos,
  onCreateNewRepo,
}: RepoSelectorProps) {
  return (
    <div className="relative dropdown-container" ref={dropdownRef}>
      <button
        onClick={onOpenDropdown}
        disabled={addingRemote}
        aria-expanded={showRepoDropdown}
        aria-haspopup="listbox"
        className={clsx(
          'w-full flex items-center justify-between px-3 py-2.5 text-sm',
          'bg-surface-800 border border-surface-700 rounded-lg',
          'transition-all duration-200',
          'leading-normal',
          showRepoDropdown
            ? 'border-primary-500/50 bg-gradient-to-b from-primary-500/10 to-primary-600/5 shadow-md'
            : 'hover:border-surface-600'
        )}
      >
        <span className="text-surface-300 truncate">
          {addingRemote ? 'Adding remote...' : 'Select repository'}
        </span>
        <ChevronDownIcon className={clsx(
          'w-4 h-4 text-surface-400 transition-transform duration-200 flex-shrink-0 ml-2',
          showRepoDropdown && 'rotate-180 text-primary-400'
        )} />
      </button>

      {showRepoDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-surface-800 border border-surface-700 rounded-lg shadow-lg z-[9960] max-h-80 overflow-hidden">
          {/* Create new repo option */}
          <button
            onClick={onCreateNewRepo}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-primary-400 hover:bg-surface-700 border-b border-surface-700"
          >
            <PlusIcon className="w-4 h-4" />
            Create new repository
          </button>

          {/* Org/User tabs */}
          <div className="flex border-b border-surface-700">
            <button
              onClick={onLoadUserRepos}
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
              <div className="flex-1 relative group dropdown-container">
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
                <div className="hidden group-hover:block absolute top-full left-0 right-0 bg-surface-800 border border-surface-700 rounded shadow-lg z-[9970]">
                  {orgs.map((org) => (
                    <button
                      key={org.id}
                      onClick={() => onSelectOrg(org.login)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-surface-300 hover:bg-surface-700 leading-normal"
                    >
                      <img
                        src={org.avatar_url}
                        alt={org.login}
                        className="w-4 h-4 rounded bg-surface-600 flex-shrink-0"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                      <span className="truncate">{org.login}</span>
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
                  onClick={() => onSelectRepo(repo)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-surface-300 hover:bg-surface-700 leading-normal"
                >
                  {repo.private ? (
                    <LockIcon className="w-4 h-4 text-surface-500 flex-shrink-0" />
                  ) : (
                    <RepoIcon className="w-4 h-4 text-surface-500 flex-shrink-0" />
                  )}
                  <span className="truncate min-w-0 flex-1">{repo.full_name}</span>
                  {repo.language && (
                    <span className="ml-auto text-xs text-surface-500 flex-shrink-0">
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
  );
}
