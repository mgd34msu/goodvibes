// ============================================================================
// HOOKS PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const hooksApi = {
  // ============================================================================
  // HOOKS CONFIGURATION
  // ============================================================================
  getHooks: () =>
    ipcRenderer.invoke('get-hooks'),
  getHook: (id: number) =>
    ipcRenderer.invoke('get-hook', id),
  createHook: (hook: {
    name: string;
    eventType: string;
    matchPattern?: string;
    command: string;
    enabled: boolean;
    timeout?: number;
    projectPath?: string;
    hookType?: 'command' | 'prompt';
    prompt?: string | null;
  }) => ipcRenderer.invoke('create-hook', hook),
  updateHook: (id: number, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-hook', { id, updates }),
  deleteHook: (id: number) =>
    ipcRenderer.invoke('delete-hook', id),
  getHooksByEvent: (eventType: string, projectPath?: string) =>
    ipcRenderer.invoke('get-hooks-by-event', { eventType, projectPath }),

  // ============================================================================
  // HOOK SERVER CONTROL
  // ============================================================================
  hookServerStatus: () =>
    ipcRenderer.invoke('hook-server-status'),
  hookServerStart: () =>
    ipcRenderer.invoke('hook-server-start'),
  hookServerStop: () =>
    ipcRenderer.invoke('hook-server-stop'),

  // ============================================================================
  // HOOK SCRIPTS MANAGEMENT
  // ============================================================================
  hookScriptsStatus: () =>
    ipcRenderer.invoke('hook-scripts-status'),
  hookScriptsInstall: () =>
    ipcRenderer.invoke('hook-scripts-install'),
  hookScriptsValidate: () =>
    ipcRenderer.invoke('hook-scripts-validate'),
  hookClaudeConfig: () =>
    ipcRenderer.invoke('hook-claude-config'),

  // ============================================================================
  // HOOK TESTING
  // ============================================================================
  testHook: (params: { command: string; input: Record<string, unknown> }): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ipcRenderer.invoke('test-hook', params),

  // ============================================================================
  // HOOK EVENT QUERIES
  // ============================================================================
  getHookEvents: (limit?: number) =>
    ipcRenderer.invoke('get-hook-events', { limit }),
  getHookEventsBySession: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke('get-hook-events-by-session', { sessionId, limit }),
  getHookEventsByType: (eventType: string, limit?: number) =>
    ipcRenderer.invoke('get-hook-events-by-type', { eventType, limit }),
  getHookEventStats: () =>
    ipcRenderer.invoke('get-hook-event-stats'),
  cleanupHookEvents: (maxAgeHours?: number) =>
    ipcRenderer.invoke('cleanup-hook-events', { maxAgeHours }),
};
