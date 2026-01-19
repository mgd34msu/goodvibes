// ============================================================================
// GITHUB TYPES - Used by both main and renderer processes
// ============================================================================

// ============================================================================
// GitHub User Types
// ============================================================================

export interface GitHubUser {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  url: string;
  html_url: string;
  type: 'User' | 'Organization';
  name: string | null;
  email: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
}

export interface GitHubOrganization {
  login: string;
  id: number;
  node_id: string;
  url: string;
  avatar_url: string;
  description: string | null;
  name: string | null;
}

// ============================================================================
// GitHub Repository Types
// ============================================================================

export interface GitHubRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  open_issues_count: number;
  archived: boolean;
  disabled: boolean;
  pushed_at: string | null;
  created_at: string;
  updated_at: string;
  owner: GitHubRepositoryOwner;
  permissions?: {
    admin: boolean;
    maintain?: boolean;
    push: boolean;
    triage?: boolean;
    pull: boolean;
  };
}

export interface GitHubRepositoryOwner {
  login: string;
  id: number;
  avatar_url: string;
  type: 'User' | 'Organization';
}

export interface CreateRepoOptions {
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  gitignore_template?: string;
  license_template?: string;
}

// ============================================================================
// GitHub Pull Request Types
// ============================================================================

export interface GitHubPullRequest {
  id: number;
  number: number;
  node_id: string;
  title: string;
  state: 'open' | 'closed';
  locked: boolean;
  html_url: string;
  diff_url: string;
  patch_url: string;
  body: string | null;
  user: GitHubPullRequestUser;
  head: GitHubPullRequestRef;
  base: GitHubPullRequestRef;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  merged_by: GitHubPullRequestUser | null;
  comments: number;
  review_comments: number;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  draft: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  labels: GitHubLabel[];
  assignees: GitHubPullRequestUser[];
  requested_reviewers: GitHubPullRequestUser[];
}

export interface GitHubPullRequestUser {
  login: string;
  id: number;
  avatar_url: string;
  type: 'User' | 'Bot';
}

export interface GitHubPullRequestRef {
  ref: string;
  sha: string;
  label: string;
  repo: {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
  };
}

export interface CreatePRData {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
  maintainer_can_modify?: boolean;
}

export interface GitHubLabel {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description: string | null;
  default: boolean;
}

// ============================================================================
// GitHub Issue Types
// ============================================================================

export interface GitHubIssue {
  id: number;
  number: number;
  node_id: string;
  title: string;
  state: 'open' | 'closed';
  locked: boolean;
  html_url: string;
  body: string | null;
  user: GitHubPullRequestUser;
  labels: GitHubLabel[];
  assignees: GitHubPullRequestUser[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  milestone: GitHubMilestone | null;
}

export interface CreateIssueData {
  title: string;
  body?: string;
  assignees?: string[];
  labels?: string[];
  milestone?: number;
}

export interface GitHubMilestone {
  id: number;
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  due_on: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// GitHub CI/CD Types
// ============================================================================

export interface GitHubCheckRun {
  id: number;
  node_id: string;
  name: string;
  head_sha: string;
  external_id: string | null;
  html_url: string | null;
  details_url: string | null;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: GitHubCheckConclusion | null;
  started_at: string | null;
  completed_at: string | null;
  output: {
    title: string | null;
    summary: string | null;
    text: string | null;
    annotations_count: number;
  };
  app: {
    id: number;
    slug: string;
    name: string;
  } | null;
}

export type GitHubCheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale';

export interface GitHubCombinedStatus {
  state: 'failure' | 'pending' | 'success';
  total_count: number;
  statuses: GitHubCommitStatus[];
  sha: string;
  repository: {
    id: number;
    name: string;
    full_name: string;
  };
}

export interface GitHubCommitStatus {
  id: number;
  state: 'error' | 'failure' | 'pending' | 'success';
  context: string;
  description: string | null;
  target_url: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// GitHub Workflow Types
// ============================================================================

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: GitHubCheckConclusion | null;
  workflow_id: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_number: number;
  event: string;
  actor: GitHubPullRequestUser;
}

// ============================================================================
// GitHub Auth Types
// ============================================================================

export interface GitHubAuthConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export interface GitHubAuthState {
  isAuthenticated: boolean;
  user: GitHubUser | null;
  accessToken: string | null;
  tokenExpiresAt: number | null;
}

export interface GitHubOAuthTokens {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
}

// ============================================================================
// GitHub API Response Types
// ============================================================================

export interface GitHubApiError {
  message: string;
  documentation_url?: string;
  status?: number;
  errors?: Array<{
    resource: string;
    field: string;
    code: string;
    message?: string;
  }>;
}

export interface GitHubListResponse<T> {
  items: T[];
  total_count: number;
  incomplete_results?: boolean;
}

// ============================================================================
// GitHub Remote Detection Types
// ============================================================================

export interface GitHubRemoteInfo {
  owner: string;
  repo: string;
  isGitHub: boolean;
  remoteName: string;
  remoteUrl: string;
}

// ============================================================================
// IPC Result Types
// ============================================================================

export interface GitHubAuthResult {
  success: boolean;
  user?: GitHubUser;
  error?: string;
}

export interface GitHubApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// GitHub Device Flow Types
// ============================================================================

/**
 * Response from GitHub's device code request
 */
export interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * State of the device flow authentication process
 */
export type DeviceFlowStatus =
  | 'idle'
  | 'awaiting_code'
  | 'polling'
  | 'completed'
  | 'expired'
  | 'cancelled'
  | 'error';

/**
 * Device flow state exposed to the renderer
 */
export interface DeviceFlowState {
  status: DeviceFlowStatus;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: number | null;
  error: string | null;
}

/**
 * Result of starting the device flow
 */
export interface DeviceFlowStartResult {
  success: boolean;
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;
  error?: string;
}

/**
 * Result of polling for device flow completion
 */
export interface DeviceFlowPollResult {
  success: boolean;
  completed: boolean;
  user?: GitHubUser;
  error?: string;
  shouldRetry?: boolean;
}

// ============================================================================
// Custom OAuth Credentials Types
// ============================================================================

/**
 * Custom OAuth credentials provided by the user
 */
export interface CustomOAuthCredentials {
  clientId: string;
  clientSecret: string | null;
  useDeviceFlow: boolean;
}

/**
 * Status of custom OAuth configuration (never exposes the actual secret)
 */
export interface CustomOAuthConfigStatus {
  isConfigured: boolean;
  source: 'default' | 'custom' | 'environment';
  clientId: string | null;
  useDeviceFlow: boolean;
  hasClientSecret: boolean;
}
