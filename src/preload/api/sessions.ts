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
  getSessionRawEntries: (id: string) =>
    ipcRenderer.invoke('get-session-raw-entries', id),
  refreshSession: (id: string) =>
    ipcRenderer.invoke('refresh-session', id),
  isSessionLive: (id: string) =>
    ipcRenderer.invoke('is-session-live', id),
  recalculateSessionCosts: () =>
    ipcRenderer.invoke('recalculate-session-costs'),
};
