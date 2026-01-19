// ============================================================================
// GITHUB IPC HANDLERS
// ============================================================================
//
// All handlers use Zod validation for input sanitization.
// ============================================================================

import { ipcMain } from 'electron';
import { ZodError } from 'zod';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import {
  githubAuthOptionsSchema,
  githubRepoParamsSchema,
  githubListReposOptionsSchema,
  githubCreateRepoSchema,
  githubListOrgReposSchema,
  githubListPRsSchema,
  githubGetPRSchema,
  githubCreatePRSchema,
  githubMergePRSchema,
  githubRefSchema,
  githubListWorkflowRunsSchema,
  githubListIssuesSchema,
  githubCreateIssueSchema,
  githubListBranchesSchema,
  githubRemoteUrlSchema,
  githubDeviceFlowOptionsSchema,
  githubSetCustomOAuthSchema,
} from '../schemas/github.js';
// numericIdSchema import removed - not used in current handlers

const logger = new Logger('IPC:GitHub');

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

interface ValidationErrorResponse {
  success: false;
  error: string;
  code: 'VALIDATION_ERROR';
  details?: Array<{ path: string; message: string }>;
}

/**
 * Format Zod validation errors into a structured response
 */
function formatValidationError(error: ZodError): ValidationErrorResponse {
  const details = error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return {
    success: false,
    error: `Validation failed: ${details.map((d) => d.message).join(', ')}`,
    code: 'VALIDATION_ERROR',
    details,
  };
}

/**
 * Validates input using a Zod schema, returning structured error on failure
 */
function validateInput<T>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: ZodError } },
  data: unknown,
  operation: string
): { success: true; data: T } | { success: false; error: ValidationErrorResponse } {
  const result = schema.safeParse(data);
  if (!result.success) {
    logger.warn(`Validation failed for ${operation}`, {
      error: result.error.message,
    });
    return { success: false, error: formatValidationError(result.error) };
  }
  return { success: true, data: result.data };
}

export function registerGitHubHandlers(): void {
  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  ipcMain.handle('github-auth', withContext('github-auth', async (_, options: unknown) => {
    const validation = validateInput(githubAuthOptionsSchema, options, 'github-auth');
    if (!validation.success) return validation.error;
    const github = await import('../../services/github.js');
    return github.authenticateWithGitHub(validation.data);
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
  // DEVICE FLOW AUTHENTICATION
  // ============================================================================

  ipcMain.handle('github-device-flow-start', withContext('github-device-flow-start', async (_, options: unknown) => {
    const validation = validateInput(githubDeviceFlowOptionsSchema, options, 'github-device-flow-start');
    if (!validation.success) return validation.error;
    const github = await import('../../services/github.js');
    return github.startDeviceFlow(validation.data);
  }));

  ipcMain.handle('github-device-flow-wait', withContext('github-device-flow-wait', async () => {
    const github = await import('../../services/github.js');
    return github.waitForDeviceFlowCompletion();
  }));

  ipcMain.handle('github-device-flow-cancel', withContext('github-device-flow-cancel', async () => {
    const github = await import('../../services/github.js');
    github.cancelDeviceFlow();
    return { success: true };
  }));

  ipcMain.handle('github-device-flow-state', withContext('github-device-flow-state', async () => {
    const github = await import('../../services/github.js');
    return github.getDeviceFlowState();
  }));

  ipcMain.handle('github-device-flow-available', withContext('github-device-flow-available', async () => {
    const github = await import('../../services/github.js');
    return github.isDeviceFlowAvailable();
  }));

  ipcMain.handle('github-device-flow-client-id', withContext('github-device-flow-client-id', async () => {
    const github = await import('../../services/github.js');
    return github.getDeviceFlowClientId();
  }));

  // ============================================================================
  // CUSTOM OAUTH CREDENTIALS
  // ============================================================================

  ipcMain.handle('github-set-custom-oauth', withContext('github-set-custom-oauth', async (_, data: unknown) => {
    const validation = validateInput(githubSetCustomOAuthSchema, data, 'github-set-custom-oauth');
    if (!validation.success) return validation.error;
    const { clientId, clientSecret, useDeviceFlow } = validation.data;
    const credentials = await import('../../services/github/credentials.js');
    credentials.setCustomOAuthCredentials(clientId, clientSecret, useDeviceFlow);
    return { success: true };
  }));

  ipcMain.handle('github-get-custom-oauth-status', withContext('github-get-custom-oauth-status', async () => {
    const credentials = await import('../../services/github/credentials.js');
    return credentials.getOAuthConfigStatus();
  }));

  ipcMain.handle('github-clear-custom-oauth', withContext('github-clear-custom-oauth', async () => {
    const credentials = await import('../../services/github/credentials.js');
    credentials.clearCustomOAuthCredentials();
    return { success: true };
  }));

  // ============================================================================
  // REPOSITORY OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-repos', withContext('github-list-repos', async (_, options: unknown) => {
    const validation = validateInput(githubListReposOptionsSchema, options, 'github-list-repos');
    if (!validation.success) return validation.error;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listUserRepos(validation.data);
  }));

  ipcMain.handle('github-get-repo', withContext('github-get-repo', async (_, data: unknown) => {
    const validation = validateInput(githubRepoParamsSchema, data, 'github-get-repo');
    if (!validation.success) return validation.error;
    const { owner, repo } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getRepo(owner, repo);
  }));

  ipcMain.handle('github-create-repo', withContext('github-create-repo', async (_, data: unknown) => {
    const validation = validateInput(githubCreateRepoSchema, data, 'github-create-repo');
    if (!validation.success) return validation.error;
    const { name, options } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.createRepo(name, options);
  }));

  ipcMain.handle('github-list-org-repos', withContext('github-list-org-repos', async (_, data: unknown) => {
    const validation = validateInput(githubListOrgReposSchema, data, 'github-list-org-repos');
    if (!validation.success) return validation.error;
    const { org, options } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listOrgRepos(org, options);
  }));

  // ============================================================================
  // PULL REQUEST OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-prs', withContext('github-list-prs', async (_, data: unknown) => {
    const validation = validateInput(githubListPRsSchema, data, 'github-list-prs');
    if (!validation.success) return validation.error;
    const { owner, repo, options } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listPullRequests(owner, repo, options);
  }));

  ipcMain.handle('github-get-pr', withContext('github-get-pr', async (_, data: unknown) => {
    const validation = validateInput(githubGetPRSchema, data, 'github-get-pr');
    if (!validation.success) return validation.error;
    const { owner, repo, number } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getPullRequest(owner, repo, number);
  }));

  ipcMain.handle('github-create-pr', withContext('github-create-pr', async (_, input: unknown) => {
    const validation = validateInput(githubCreatePRSchema, input, 'github-create-pr');
    if (!validation.success) return validation.error;
    const { owner, repo, data } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.createPullRequest(owner, repo, data);
  }));

  ipcMain.handle('github-merge-pr', withContext('github-merge-pr', async (_, data: unknown) => {
    const validation = validateInput(githubMergePRSchema, data, 'github-merge-pr');
    if (!validation.success) return validation.error;
    const { owner, repo, number, options } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.mergePullRequest(owner, repo, number, options);
  }));

  ipcMain.handle('github-close-pr', withContext('github-close-pr', async (_, data: unknown) => {
    const validation = validateInput(githubGetPRSchema, data, 'github-close-pr');
    if (!validation.success) return validation.error;
    const { owner, repo, number } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.closePullRequest(owner, repo, number);
  }));

  // ============================================================================
  // CI/CD STATUS OPERATIONS
  // ============================================================================

  ipcMain.handle('github-get-checks', withContext('github-get-checks', async (_, data: unknown) => {
    const validation = validateInput(githubRefSchema, data, 'github-get-checks');
    if (!validation.success) return validation.error;
    const { owner, repo, ref } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getCheckRuns(owner, repo, ref);
  }));

  ipcMain.handle('github-get-commit-status', withContext('github-get-commit-status', async (_, data: unknown) => {
    const validation = validateInput(githubRefSchema, data, 'github-get-commit-status');
    if (!validation.success) return validation.error;
    const { owner, repo, ref } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getCommitStatus(owner, repo, ref);
  }));

  ipcMain.handle('github-list-workflow-runs', withContext('github-list-workflow-runs', async (_, data: unknown) => {
    const validation = validateInput(githubListWorkflowRunsSchema, data, 'github-list-workflow-runs');
    if (!validation.success) return validation.error;
    const { owner, repo, options } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listWorkflowRuns(owner, repo, options);
  }));

  // ============================================================================
  // ISSUE OPERATIONS
  // ============================================================================

  ipcMain.handle('github-list-issues', withContext('github-list-issues', async (_, data: unknown) => {
    const validation = validateInput(githubListIssuesSchema, data, 'github-list-issues');
    if (!validation.success) return validation.error;
    const { owner, repo, options } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listIssues(owner, repo, options);
  }));

  ipcMain.handle('github-get-issue', withContext('github-get-issue', async (_, data: unknown) => {
    const validation = validateInput(githubGetPRSchema, data, 'github-get-issue');
    if (!validation.success) return validation.error;
    const { owner, repo, number } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.getIssue(owner, repo, number);
  }));

  ipcMain.handle('github-create-issue', withContext('github-create-issue', async (_, input: unknown) => {
    const validation = validateInput(githubCreateIssueSchema, input, 'github-create-issue');
    if (!validation.success) return validation.error;
    const { owner, repo, data } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.createIssue(owner, repo, data);
  }));

  ipcMain.handle('github-close-issue', withContext('github-close-issue', async (_, data: unknown) => {
    const validation = validateInput(githubGetPRSchema, data, 'github-close-issue');
    if (!validation.success) return validation.error;
    const { owner, repo, number } = validation.data;
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

  ipcMain.handle('github-list-branches', withContext('github-list-branches', async (_, data: unknown) => {
    const validation = validateInput(githubListBranchesSchema, data, 'github-list-branches');
    if (!validation.success) return validation.error;
    const { owner, repo, options } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.listBranches(owner, repo, options);
  }));

  // ============================================================================
  // UTILITY OPERATIONS
  // ============================================================================

  ipcMain.handle('github-parse-remote', withContext('github-parse-remote', async (_, data: unknown) => {
    const validation = validateInput(githubRemoteUrlSchema, data, 'github-parse-remote');
    if (!validation.success) return validation.error;
    const { remoteUrl } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.parseGitHubRemote(remoteUrl);
  }));

  ipcMain.handle('github-is-github-remote', withContext('github-is-github-remote', async (_, data: unknown) => {
    const validation = validateInput(githubRemoteUrlSchema, data, 'github-is-github-remote');
    if (!validation.success) return validation.error;
    const { remoteUrl } = validation.data;
    const githubApi = await import('../../services/githubApi.js');
    return githubApi.isGitHubRemote(remoteUrl);
  }));

  logger.info('GitHub handlers registered (with Zod validation)');
}
