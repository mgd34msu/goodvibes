// ============================================================================
// GITHUB API SERVICE
// ============================================================================

import { Octokit } from '@octokit/rest';
import { Logger } from './logger.js';
import { getAccessToken, refreshTokenIfNeeded } from './github.js';
import type {
  GitHubRepository,
  GitHubPullRequest,
  GitHubIssue,
  GitHubCheckRun,
  GitHubCombinedStatus,
  GitHubUser,
  GitHubOrganization,
  GitHubWorkflowRun,
  GitHubApiResult,
  CreateRepoOptions,
  CreatePRData,
  CreateIssueData,
  GitHubRemoteInfo,
} from '../../shared/types/github.js';

const logger = new Logger('GitHubAPI');

// ============================================================================
// OCTOKIT INSTANCE
// ============================================================================

/**
 * Get an authenticated Octokit instance
 * Refreshes token if needed before creating the instance
 */
async function getOctokit(): Promise<Octokit | null> {
  await refreshTokenIfNeeded();

  const token = getAccessToken();
  if (!token) {
    logger.warn('No GitHub access token available');
    return null;
  }

  return new Octokit({
    auth: token,
    userAgent: 'GoodVibes',
  });
}

/**
 * Helper to wrap API calls with error handling
 */
async function apiCall<T>(
  operation: string,
  fn: (octokit: Octokit) => Promise<T>
): Promise<GitHubApiResult<T>> {
  try {
    const octokit = await getOctokit();
    if (!octokit) {
      return {
        success: false,
        error: 'Not authenticated with GitHub',
      };
    }

    const data = await fn(octokit);
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`GitHub API error in ${operation}`, error);
    return {
      success: false,
      error: message,
    };
  }
}

// ============================================================================
// USER & ORGANIZATION OPERATIONS
// ============================================================================

/**
 * Get the currently authenticated user
 */
export async function getCurrentUser(): Promise<GitHubApiResult<GitHubUser>> {
  return apiCall('getCurrentUser', async (octokit) => {
    const { data } = await octokit.users.getAuthenticated();
    return data as GitHubUser;
  });
}

/**
 * List organizations the user is a member of
 */
export async function listOrganizations(): Promise<GitHubApiResult<GitHubOrganization[]>> {
  return apiCall('listOrganizations', async (octokit) => {
    const { data } = await octokit.orgs.listForAuthenticatedUser();
    return data.map(org => ({
      login: org.login,
      id: org.id,
      node_id: org.node_id,
      url: org.url,
      avatar_url: org.avatar_url,
      description: org.description,
      name: null, // Not returned in list endpoint
    })) as GitHubOrganization[];
  });
}

// ============================================================================
// REPOSITORY OPERATIONS
// ============================================================================

/**
 * Get a specific repository
 */
export async function getRepo(
  owner: string,
  repo: string
): Promise<GitHubApiResult<GitHubRepository>> {
  return apiCall('getRepo', async (octokit) => {
    const { data } = await octokit.repos.get({ owner, repo });
    return data as unknown as GitHubRepository;
  });
}

/**
 * List repositories for the authenticated user
 */
export async function listUserRepos(options?: {
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}): Promise<GitHubApiResult<GitHubRepository[]>> {
  return apiCall('listUserRepos', async (octokit) => {
    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort: options?.sort || 'pushed',
      direction: options?.direction || 'desc',
      per_page: options?.per_page || 30,
      page: options?.page || 1,
    });
    return data as unknown as GitHubRepository[];
  });
}

/**
 * List repositories for an organization
 */
export async function listOrgRepos(
  org: string,
  options?: {
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
  }
): Promise<GitHubApiResult<GitHubRepository[]>> {
  return apiCall('listOrgRepos', async (octokit) => {
    const { data } = await octokit.repos.listForOrg({
      org,
      sort: options?.sort || 'pushed',
      direction: options?.direction || 'desc',
      per_page: options?.per_page || 30,
      page: options?.page || 1,
    });
    return data as unknown as GitHubRepository[];
  });
}

/**
 * Create a new repository
 */
export async function createRepo(
  name: string,
  options?: CreateRepoOptions
): Promise<GitHubApiResult<GitHubRepository>> {
  return apiCall('createRepo', async (octokit) => {
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name,
      description: options?.description,
      private: options?.private ?? false,
      auto_init: options?.auto_init ?? false,
      gitignore_template: options?.gitignore_template,
      license_template: options?.license_template,
    });
    return data as unknown as GitHubRepository;
  });
}

// ============================================================================
// PULL REQUEST OPERATIONS
// ============================================================================

/**
 * List pull requests for a repository
 */
export async function listPullRequests(
  owner: string,
  repo: string,
  options?: {
    state?: 'open' | 'closed' | 'all';
    sort?: 'created' | 'updated' | 'popularity' | 'long-running';
    direction?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
  }
): Promise<GitHubApiResult<GitHubPullRequest[]>> {
  return apiCall('listPullRequests', async (octokit) => {
    const { data } = await octokit.pulls.list({
      owner,
      repo,
      state: options?.state || 'open',
      sort: options?.sort || 'updated',
      direction: options?.direction || 'desc',
      per_page: options?.per_page || 30,
      page: options?.page || 1,
    });
    return data as unknown as GitHubPullRequest[];
  });
}

/**
 * Get a specific pull request
 */
export async function getPullRequest(
  owner: string,
  repo: string,
  pull_number: number
): Promise<GitHubApiResult<GitHubPullRequest>> {
  return apiCall('getPullRequest', async (octokit) => {
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
    });
    return data as unknown as GitHubPullRequest;
  });
}

/**
 * Create a new pull request
 */
export async function createPullRequest(
  owner: string,
  repo: string,
  data: CreatePRData
): Promise<GitHubApiResult<GitHubPullRequest>> {
  return apiCall('createPullRequest', async (octokit) => {
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title: data.title,
      body: data.body,
      head: data.head,
      base: data.base,
      draft: data.draft,
      maintainer_can_modify: data.maintainer_can_modify ?? true,
    });
    return pr as unknown as GitHubPullRequest;
  });
}

/**
 * Merge a pull request
 */
export async function mergePullRequest(
  owner: string,
  repo: string,
  pull_number: number,
  options?: {
    commit_title?: string;
    commit_message?: string;
    merge_method?: 'merge' | 'squash' | 'rebase';
  }
): Promise<GitHubApiResult<{ merged: boolean; sha: string; message: string }>> {
  return apiCall('mergePullRequest', async (octokit) => {
    const { data } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number,
      commit_title: options?.commit_title,
      commit_message: options?.commit_message,
      merge_method: options?.merge_method || 'merge',
    });
    return data;
  });
}

/**
 * Close a pull request without merging
 */
export async function closePullRequest(
  owner: string,
  repo: string,
  pull_number: number
): Promise<GitHubApiResult<GitHubPullRequest>> {
  return apiCall('closePullRequest', async (octokit) => {
    const { data } = await octokit.pulls.update({
      owner,
      repo,
      pull_number,
      state: 'closed',
    });
    return data as unknown as GitHubPullRequest;
  });
}

// ============================================================================
// CI/CD STATUS OPERATIONS
// ============================================================================

/**
 * Get check runs for a specific ref (branch, tag, or commit)
 * Returns empty array if ref is not found (404/422 errors)
 */
export async function getCheckRuns(
  owner: string,
  repo: string,
  ref: string
): Promise<GitHubApiResult<GitHubCheckRun[]>> {
  return apiCall('getCheckRuns', async (octokit) => {
    try {
      const { data } = await octokit.checks.listForRef({
        owner,
        repo,
        ref,
      });
      return data.check_runs as unknown as GitHubCheckRun[];
    } catch (error: unknown) {
      const e = error as { status?: number; message?: string };
      // Return empty array if ref doesn't exist (404) or is invalid (422)
      if (e.status === 404 || e.status === 422) {
        logger.debug(`Ref "${ref}" not found for ${owner}/${repo} - returning empty check runs`);
        return [];
      }
      throw error;
    }
  });
}

/**
 * Get combined commit status
 * Returns null if ref is not found (404/422 errors)
 */
export async function getCommitStatus(
  owner: string,
  repo: string,
  ref: string
): Promise<GitHubApiResult<GitHubCombinedStatus | null>> {
  return apiCall('getCommitStatus', async (octokit) => {
    try {
      const { data } = await octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref,
      });
      return data as unknown as GitHubCombinedStatus;
    } catch (error: unknown) {
      const e = error as { status?: number; message?: string };
      // Return null if ref doesn't exist (404) or is invalid (422)
      if (e.status === 404 || e.status === 422) {
        logger.debug(`Ref "${ref}" not found for ${owner}/${repo} - returning null commit status`);
        return null;
      }
      throw error;
    }
  });
}

/**
 * List workflow runs for a repository
 */
export async function listWorkflowRuns(
  owner: string,
  repo: string,
  options?: {
    branch?: string;
    event?: string;
    status?: 'queued' | 'in_progress' | 'completed';
    per_page?: number;
    page?: number;
  }
): Promise<GitHubApiResult<GitHubWorkflowRun[]>> {
  return apiCall('listWorkflowRuns', async (octokit) => {
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      branch: options?.branch,
      event: options?.event,
      status: options?.status,
      per_page: options?.per_page || 10,
      page: options?.page || 1,
    });
    return data.workflow_runs as unknown as GitHubWorkflowRun[];
  });
}

// ============================================================================
// ISSUE OPERATIONS
// ============================================================================

/**
 * List issues for a repository
 */
export async function listIssues(
  owner: string,
  repo: string,
  options?: {
    state?: 'open' | 'closed' | 'all';
    sort?: 'created' | 'updated' | 'comments';
    direction?: 'asc' | 'desc';
    labels?: string;
    per_page?: number;
    page?: number;
  }
): Promise<GitHubApiResult<GitHubIssue[]>> {
  return apiCall('listIssues', async (octokit) => {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: options?.state || 'open',
      sort: options?.sort || 'updated',
      direction: options?.direction || 'desc',
      labels: options?.labels,
      per_page: options?.per_page || 30,
      page: options?.page || 1,
    });
    // Filter out pull requests (GitHub API returns PRs as issues too)
    return data.filter((issue) => !issue.pull_request) as unknown as GitHubIssue[];
  });
}

/**
 * Get a specific issue
 */
export async function getIssue(
  owner: string,
  repo: string,
  issue_number: number
): Promise<GitHubApiResult<GitHubIssue>> {
  return apiCall('getIssue', async (octokit) => {
    const { data } = await octokit.issues.get({
      owner,
      repo,
      issue_number,
    });
    return data as unknown as GitHubIssue;
  });
}

/**
 * Create a new issue
 */
export async function createIssue(
  owner: string,
  repo: string,
  data: CreateIssueData
): Promise<GitHubApiResult<GitHubIssue>> {
  return apiCall('createIssue', async (octokit) => {
    const { data: issue } = await octokit.issues.create({
      owner,
      repo,
      title: data.title,
      body: data.body,
      assignees: data.assignees,
      labels: data.labels,
      milestone: data.milestone,
    });
    return issue as unknown as GitHubIssue;
  });
}

/**
 * Close an issue
 */
export async function closeIssue(
  owner: string,
  repo: string,
  issue_number: number
): Promise<GitHubApiResult<GitHubIssue>> {
  return apiCall('closeIssue', async (octokit) => {
    const { data } = await octokit.issues.update({
      owner,
      repo,
      issue_number,
      state: 'closed',
    });
    return data as unknown as GitHubIssue;
  });
}

// ============================================================================
// BRANCH OPERATIONS
// ============================================================================

/**
 * List branches for a repository
 */
export async function listBranches(
  owner: string,
  repo: string,
  options?: {
    protected_only?: boolean;
    per_page?: number;
    page?: number;
  }
): Promise<GitHubApiResult<Array<{ name: string; protected: boolean; sha: string }>>> {
  return apiCall('listBranches', async (octokit) => {
    const { data } = await octokit.repos.listBranches({
      owner,
      repo,
      protected: options?.protected_only,
      per_page: options?.per_page || 100,
      page: options?.page || 1,
    });
    return data.map((branch) => ({
      name: branch.name,
      protected: branch.protected,
      sha: branch.commit.sha,
    }));
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Parse a GitHub remote URL to extract owner and repo
 * Supports: https://github.com/owner/repo.git, git@github.com:owner/repo.git
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRemoteInfo | null {
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
      isGitHub: true,
      remoteName: '',
      remoteUrl,
    };
  }

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      isGitHub: true,
      remoteName: '',
      remoteUrl,
    };
  }

  return null;
}

/**
 * Check if a remote URL is a GitHub repository
 */
export function isGitHubRemote(remoteUrl: string): boolean {
  return remoteUrl.includes('github.com');
}

/**
 * Get the default branch for a repository
 */
export async function getDefaultBranch(
  owner: string,
  repo: string
): Promise<GitHubApiResult<string>> {
  const result = await getRepo(owner, repo);
  if (!result.success || !result.data) {
    return { success: false, error: result.error };
  }
  return { success: true, data: result.data.default_branch };
}

/**
 * Check if a branch exists
 */
export async function branchExists(
  owner: string,
  repo: string,
  branch: string
): Promise<GitHubApiResult<boolean>> {
  return apiCall('branchExists', async (octokit) => {
    try {
      await octokit.repos.getBranch({ owner, repo, branch });
      return true;
    } catch (error: unknown) {
      const e = error as { status?: number };
      if (e.status === 404) {
        return false;
      }
      throw error;
    }
  });
}
