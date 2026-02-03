// ============================================================================
// GITHUB PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const githubApi = {
  // ============================================================================
  // AUTHENTICATION
  // ============================================================================
  githubAuth: (options?: { scopes?: string[] }) =>
    ipcRenderer.invoke('github-auth', options),
  githubLogout: () =>
    ipcRenderer.invoke('github-logout'),
  githubIsAuthenticated: () =>
    ipcRenderer.invoke('github-is-authenticated'),
  githubGetUser: () =>
    ipcRenderer.invoke('github-get-user'),
  githubGetAuthState: () =>
    ipcRenderer.invoke('github-get-auth-state'),
  githubGetOAuthConfig: () =>
    ipcRenderer.invoke('github-get-oauth-config'),

  // ============================================================================
  // DEVICE FLOW AUTHENTICATION
  // ============================================================================
  /**
   * Start the device flow authentication process.
   * Returns a user code and verification URL for the user to authorize.
   */
  githubDeviceFlowStart: (options?: { scopes?: string[]; openBrowser?: boolean }) =>
    ipcRenderer.invoke('github-device-flow-start', options),

  /**
   * Wait for the device flow to complete.
   * This is a long-polling call that resolves when the user authorizes or the flow times out.
   */
  githubDeviceFlowWait: () =>
    ipcRenderer.invoke('github-device-flow-wait'),

  /**
   * Cancel an active device flow.
   */
  githubDeviceFlowCancel: () =>
    ipcRenderer.invoke('github-device-flow-cancel'),

  /**
   * Get the current device flow state.
   */
  githubDeviceFlowState: () =>
    ipcRenderer.invoke('github-device-flow-state'),

  /**
   * Check if device flow is available.
   */
  githubDeviceFlowAvailable: () =>
    ipcRenderer.invoke('github-device-flow-available'),

  /**
   * Get the configured GitHub client ID.
   */
  githubDeviceFlowClientId: () =>
    ipcRenderer.invoke('github-device-flow-client-id'),

  /**
   * Subscribe to device flow state changes.
   */
  onDeviceFlowStateChange: (callback: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('github-device-flow-state', handler);
    return () => {
      ipcRenderer.removeListener('github-device-flow-state', handler);
    };
  },

  // ============================================================================
  // CUSTOM OAUTH CREDENTIALS
  // ============================================================================

  /**
   * Set custom OAuth credentials.
   * Use this to configure a custom GitHub OAuth App.
   */
  githubSetCustomOAuth: (config: { clientId: string; clientSecret: string | null; useDeviceFlow: boolean }) =>
    ipcRenderer.invoke('github-set-custom-oauth', config),

  /**
   * Get the current custom OAuth configuration status.
   * Never returns the actual client secret, only whether one is configured.
   */
  githubGetCustomOAuthStatus: () =>
    ipcRenderer.invoke('github-get-custom-oauth-status'),

  /**
   * Clear custom OAuth credentials.
   * Reverts to using environment variables or the default bundled credentials.
   */
  githubClearCustomOAuth: () =>
    ipcRenderer.invoke('github-clear-custom-oauth'),

  // ============================================================================
  // REPOSITORY OPERATIONS
  // ============================================================================
  githubListRepos: (options?: { sort?: string; direction?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-repos', options),
  githubGetRepo: (owner: string, repo: string) =>
    ipcRenderer.invoke('github-get-repo', { owner, repo }),
  githubCreateRepo: (name: string, options?: { description?: string; private?: boolean; auto_init?: boolean }) =>
    ipcRenderer.invoke('github-create-repo', { name, options }),
  githubListOrgRepos: (org: string, options?: { sort?: string; direction?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-org-repos', { org, options }),

  // ============================================================================
  // PULL REQUEST OPERATIONS
  // ============================================================================
  githubListPRs: (owner: string, repo: string, options?: { state?: string; sort?: string; direction?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-prs', { owner, repo, options }),
  githubGetPR: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-get-pr', { owner, repo, number }),
  githubCreatePR: (owner: string, repo: string, data: { title: string; body?: string; head: string; base: string; draft?: boolean }) =>
    ipcRenderer.invoke('github-create-pr', { owner, repo, data }),
  githubMergePR: (owner: string, repo: string, number: number, options?: { commit_title?: string; commit_message?: string; merge_method?: string }) =>
    ipcRenderer.invoke('github-merge-pr', { owner, repo, number, options }),
  githubClosePR: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-close-pr', { owner, repo, number }),

  // ============================================================================
  // CI/CD STATUS OPERATIONS
  // ============================================================================
  githubGetChecks: (owner: string, repo: string, ref: string) =>
    ipcRenderer.invoke('github-get-checks', { owner, repo, ref }),
  githubGetCommitStatus: (owner: string, repo: string, ref: string) =>
    ipcRenderer.invoke('github-get-commit-status', { owner, repo, ref }),
  githubListWorkflowRuns: (owner: string, repo: string, options?: { branch?: string; event?: string; status?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-workflow-runs', { owner, repo, options }),

  // ============================================================================
  // ISSUE OPERATIONS
  // ============================================================================
  githubListIssues: (owner: string, repo: string, options?: { state?: string; sort?: string; direction?: string; labels?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-issues', { owner, repo, options }),
  githubGetIssue: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-get-issue', { owner, repo, number }),
  githubCreateIssue: (owner: string, repo: string, data: { title: string; body?: string; assignees?: string[]; labels?: string[] }) =>
    ipcRenderer.invoke('github-create-issue', { owner, repo, data }),
  githubCloseIssue: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-close-issue', { owner, repo, number }),

  // ============================================================================
  // ORGANIZATION OPERATIONS
  // ============================================================================
  githubListOrgs: () =>
    ipcRenderer.invoke('github-list-orgs'),

  // ============================================================================
  // BRANCH OPERATIONS
  // ============================================================================
  githubListBranches: (owner: string, repo: string, options?: { protected_only?: boolean; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-branches', { owner, repo, options }),

  // ============================================================================
  // UTILITY OPERATIONS
  // ============================================================================
  githubParseRemote: (remoteUrl: string) =>
    ipcRenderer.invoke('github-parse-remote', { remoteUrl }),
  githubIsGitHubRemote: (remoteUrl: string) =>
    ipcRenderer.invoke('github-is-github-remote', { remoteUrl }),
};
