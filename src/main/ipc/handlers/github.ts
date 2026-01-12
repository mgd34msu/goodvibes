// ============================================================================
// GITHUB IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';

const logger = new Logger('IPC:GitHub');

export function registerGitHubHandlers(): void {
  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  ipcMain.handle('github-auth', withContext('github-auth', async (_, options?: { scopes?: string[] }) => {
    const github = await import('../../services/github.js');
    return github.authenticateWithGitHub(options);
  }));

  ipcMain.handle('github-logout', withContext('github-logout', async () => {
    const github = await import('../../services/github.js');
    await github.logout();
    return { success: true };
  }));

  ipcMain.handle('github-is-authenticated', withContext('github-is-authenticated', async () => {
    const github = await import('../../services/github.js');
    return github.isAuthenticated();
  }));

  ipcMain.handle('github-get-user', withContext('github-get-user', async () => {
    const github = await import('../../services/github.js');
    return github.getCurrentUser();
  }));

  ipcMain.handle('github-get-auth-state', withContext('github-get-auth-state', async () => {
    const github = await import('../../services/github.js');
    return github.getAuthState();
  }));

  ipcMain.handle('github-get-oauth-config', withContext('github-get-oauth-config', async () => {
    const github = await import('../../services/github.js');
    return github.getOAuthConfig();
  }));

  // ============================================================================
  // REPOSITORY OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-repos', withContext('github-list-repos', async (_, options?: { sort?: 'created' | 'updated' | 'pushed' | 'full_name'; direction?: 'asc' | 'desc'; per_page?: number; page?: number }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listUserRepos(options);
  }));

  ipcMain.handle('github-get-repo', withContext('github-get-repo', async (_, { owner, repo }: { owner: string; repo: string }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getRepo(owner, repo);
  }));

  ipcMain.handle('github-create-repo', withContext('github-create-repo', async (_, { name, options }: { name: string; options?: { description?: string; private?: boolean; auto_init?: boolean } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.createRepo(name, options);
  }));

  ipcMain.handle('github-list-org-repos', withContext('github-list-org-repos', async (_, { org, options }: { org: string; options?: { sort?: 'created' | 'updated' | 'pushed' | 'full_name'; direction?: 'asc' | 'desc'; per_page?: number; page?: number } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listOrgRepos(org, options);
  }));

  // ============================================================================
  // PULL REQUEST OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-prs', withContext('github-list-prs', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { state?: 'open' | 'closed' | 'all'; sort?: 'created' | 'updated' | 'popularity' | 'long-running'; direction?: 'asc' | 'desc'; per_page?: number; page?: number } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listPullRequests(owner, repo, options);
  }));

  ipcMain.handle('github-get-pr', withContext('github-get-pr', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getPullRequest(owner, repo, number);
  }));

  ipcMain.handle('github-create-pr', withContext('github-create-pr', async (_, { owner, repo, data }: { owner: string; repo: string; data: { title: string; body?: string; head: string; base: string; draft?: boolean } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.createPullRequest(owner, repo, data);
  }));

  ipcMain.handle('github-merge-pr', withContext('github-merge-pr', async (_, { owner, repo, number, options }: { owner: string; repo: string; number: number; options?: { commit_title?: string; commit_message?: string; merge_method?: 'merge' | 'squash' | 'rebase' } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.mergePullRequest(owner, repo, number, options);
  }));

  ipcMain.handle('github-close-pr', withContext('github-close-pr', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.closePullRequest(owner, repo, number);
  }));

  // ============================================================================
  // CI/CD STATUS OPERATIONS
  // ============================================================================

  ipcMain.handle('github-get-checks', withContext('github-get-checks', async (_, { owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getCheckRuns(owner, repo, ref);
  }));

  ipcMain.handle('github-get-commit-status', withContext('github-get-commit-status', async (_, { owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getCommitStatus(owner, repo, ref);
  }));

  ipcMain.handle('github-list-workflow-runs', withContext('github-list-workflow-runs', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { branch?: string; event?: string; status?: 'queued' | 'in_progress' | 'completed'; per_page?: number; page?: number } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listWorkflowRuns(owner, repo, options);
  }));

  // ============================================================================
  // ISSUE OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-issues', withContext('github-list-issues', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { state?: 'open' | 'closed' | 'all'; sort?: 'created' | 'updated' | 'comments'; direction?: 'asc' | 'desc'; labels?: string; per_page?: number; page?: number } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listIssues(owner, repo, options);
  }));

  ipcMain.handle('github-get-issue', withContext('github-get-issue', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getIssue(owner, repo, number);
  }));

  ipcMain.handle('github-create-issue', withContext('github-create-issue', async (_, { owner, repo, data }: { owner: string; repo: string; data: { title: string; body?: string; assignees?: string[]; labels?: string[] } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.createIssue(owner, repo, data);
  }));

  ipcMain.handle('github-close-issue', withContext('github-close-issue', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.closeIssue(owner, repo, number);
  }));

  // ============================================================================
  // ORGANIZATION OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-orgs', withContext('github-list-orgs', async () => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listOrganizations();
  }));

  // ============================================================================
  // BRANCH OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-branches', withContext('github-list-branches', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { protected_only?: boolean; per_page?: number; page?: number } }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listBranches(owner, repo, options);
  }));

  // ============================================================================
  // UTILITY OPERATIONS
  // ============================================================================

  ipcMain.handle('github-parse-remote', withContext('github-parse-remote', async (_, { remoteUrl }: { remoteUrl: string }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.parseGitHubRemote(remoteUrl);
  }));

  ipcMain.handle('github-is-github-remote', withContext('github-is-github-remote', async (_, { remoteUrl }: { remoteUrl: string }) => {
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.isGitHubRemote(remoteUrl);
  }));

  logger.info('GitHub handlers registered');
}
