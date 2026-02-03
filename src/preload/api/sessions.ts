// ============================================================================
// SESSIONS PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const sessionsApi = {
  getSessions: () =>
    ipcRenderer.invoke('get-sessions'),
  getSession: (id: string) =>
    ipcRenderer.invoke('get-session', id),
  getSessionMessages: (id: string) =>
    ipcRenderer.invoke('get-session-messages', id),
  getActiveSessions: () =>
    ipcRenderer.invoke('get-active-sessions'),
  getFavoriteSessions: () =>
    ipcRenderer.invoke('get-favorite-sessions'),
  getArchivedSessions: () =>
    ipcRenderer.invoke('get-archived-sessions'),
  toggleFavorite: (id: string) =>
    ipcRenderer.invoke('toggle-favorite', id),
  toggleArchive: (id: string) =>
    ipcRenderer.invoke('toggle-archive', id),
  deleteSession: (id: string) =>
    ipcRenderer.invoke('delete-session', id),
  getLiveSessions: () =>
    ipcRenderer.invoke('get-live-sessions'),
  getSessionRawEntries: (id: string, afterIndex?: number) =>
    ipcRenderer.invoke('get-session-raw-entries', id, afterIndex),
  refreshSession: (id: string) =>
    ipcRenderer.invoke('refresh-session', id),
  isSessionLive: (id: string) =>
    ipcRenderer.invoke('is-session-live', id),
  watchSession: (id: string) =>
    ipcRenderer.invoke('watch-session', id) as Promise<string | null>,
  recalculateSessionCosts: () =>
    ipcRenderer.invoke('recalculate-session-costs'),
  rescanSessions: () =>
    ipcRenderer.invoke('rescan-sessions'),
  scanNewSessions: () =>
    ipcRenderer.invoke('scan-new-sessions') as Promise<number>,
  // Session summaries (for project-based session lookup)
  getProjectSessions: (projectPath: string, limit?: number) =>
    ipcRenderer.invoke('session:getForProject', projectPath, limit ?? 5),
  getMostRecentSession: () =>
    ipcRenderer.invoke('session:getMostRecent') as Promise<{
      sessionId: string;
      cwd: string;
      messageCount: number;
      costUsd: number;
      startedAt: string;
      lastActive: string;
      firstPrompt?: string;
    } | null>,
};
