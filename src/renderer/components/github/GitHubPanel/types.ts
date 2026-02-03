// ============================================================================
// GITHUB PANEL - TYPE DEFINITIONS
// ============================================================================

import type { GitHubCheckRun, GitHubCombinedStatus, GitHubRepository, GitHubOrganization } from '../../../../shared/types/github';

export interface GitHubPanelProps {
  cwd: string;
  currentBranch?: string;
  className?: string;
}

export interface CIStatusPanelProps {
  checks: GitHubCheckRun[];
  combined: GitHubCombinedStatus | null;
  loading: boolean;
  onRefresh: () => void;
}

export interface CreateRepositoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (repo: GitHubRepository) => void;
  defaultName?: string;
}

export interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

export interface RepoSelectorState {
  showRepoDropdown: boolean;
  repos: GitHubRepository[];
  orgs: GitHubOrganization[];
  reposLoading: boolean;
  selectedOrg: string | null;
  addingRemote: boolean;
}

export type CombinedCIState = 'failure' | 'pending' | 'success';
