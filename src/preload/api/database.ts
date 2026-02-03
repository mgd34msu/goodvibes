// ============================================================================
// DATABASE PRELOAD API
// ============================================================================
//
// Collections, tags, prompts, notes, notifications, knowledge, search, analytics
// ============================================================================

import { ipcRenderer } from 'electron';

export const databaseApi = {
  // ============================================================================
  // ANALYTICS
  // ============================================================================
  getAnalytics: () =>
    ipcRenderer.invoke('get-analytics'),
  getToolUsage: () =>
    ipcRenderer.invoke('get-tool-usage'),

  // ============================================================================
  // COLLECTIONS
  // ============================================================================
  getCollections: () =>
    ipcRenderer.invoke('get-collections'),
  createCollection: (name: string, color?: string, icon?: string) =>
    ipcRenderer.invoke('create-collection', { name, color, icon }),
  updateCollection: (id: number, name: string, color: string, icon: string) =>
    ipcRenderer.invoke('update-collection', { id, name, color, icon }),
  deleteCollection: (id: number) =>
    ipcRenderer.invoke('delete-collection', id),
  addSessionToCollection: (sessionId: string, collectionId: number) =>
    ipcRenderer.invoke('add-session-to-collection', { sessionId, collectionId }),

  // Smart Collections
  getSmartCollections: () =>
    ipcRenderer.invoke('get-smart-collections'),
  createSmartCollection: (name: string, rules: unknown[], color?: string, icon?: string, matchMode?: string) =>
    ipcRenderer.invoke('create-smart-collection', { name, rules, color, icon, matchMode }),
  getSmartCollectionSessions: (id: number) =>
    ipcRenderer.invoke('get-smart-collection-sessions', id),
  deleteSmartCollection: (id: number) =>
    ipcRenderer.invoke('delete-smart-collection', id),

  // PROMPTS
  // ============================================================================
  getPrompts: () =>
    ipcRenderer.invoke('get-prompts'),
  savePrompt: (title: string, content: string, category?: string) =>
    ipcRenderer.invoke('save-prompt', { title, content, category }),
  usePrompt: (id: number) =>
    ipcRenderer.invoke('use-prompt', id),
  deletePrompt: (id: number) =>
    ipcRenderer.invoke('delete-prompt', id),

  // ============================================================================
  // NOTES
  // ============================================================================
  getQuickNotes: (status: string) =>
    ipcRenderer.invoke('get-quick-notes', status),
  createQuickNote: (content: string, sessionId?: string, priority?: string) =>
    ipcRenderer.invoke('create-quick-note', { content, sessionId, priority }),
  updateQuickNote: (id: number, content: string) =>
    ipcRenderer.invoke('update-quick-note', { id, content }),
  setQuickNoteStatus: (id: number, status: string) =>
    ipcRenderer.invoke('set-quick-note-status', { id, status }),
  deleteQuickNote: (id: number) =>
    ipcRenderer.invoke('delete-quick-note', id),

  // ============================================================================
  // NOTIFICATIONS
  // ============================================================================
  getNotifications: (includeRead?: boolean, limit?: number) =>
    ipcRenderer.invoke('get-notifications', { includeRead, limit }),
  getUnreadNotificationCount: () =>
    ipcRenderer.invoke('get-unread-notification-count'),
  markNotificationRead: (id: number) =>
    ipcRenderer.invoke('mark-notification-read', id),
  markAllNotificationsRead: () =>
    ipcRenderer.invoke('mark-all-notifications-read'),
  dismissAllNotifications: () =>
    ipcRenderer.invoke('dismiss-all-notifications'),

  // ============================================================================
  // KNOWLEDGE BASE
  // ============================================================================
  getAllKnowledgeEntries: () =>
    ipcRenderer.invoke('get-all-knowledge-entries'),
  getKnowledgeEntry: (id: number) =>
    ipcRenderer.invoke('get-knowledge-entry', id),
  createKnowledgeEntry: (title: string, content: string, category?: string, tags?: string) =>
    ipcRenderer.invoke('create-knowledge-entry', { title, content, category, tags }),
  updateKnowledgeEntry: (id: number, title: string, content: string, category?: string, tags?: string) =>
    ipcRenderer.invoke('update-knowledge-entry', { id, title, content, category, tags }),
  deleteKnowledgeEntry: (id: number) =>
    ipcRenderer.invoke('delete-knowledge-entry', id),
  searchKnowledge: (term: string) =>
    ipcRenderer.invoke('search-knowledge', term),

  // ============================================================================
  // SEARCH
  // ============================================================================
  searchSessions: (query: string) =>
    ipcRenderer.invoke('search-sessions', query),
  searchSessionsAdvanced: (options: unknown) =>
    ipcRenderer.invoke('search-sessions-advanced', options),
  saveSearch: (name: string, query: string, filters?: unknown) =>
    ipcRenderer.invoke('save-search', { name, query, filters }),
  getSavedSearches: () =>
    ipcRenderer.invoke('get-saved-searches'),
  deleteSavedSearch: (id: number) =>
    ipcRenderer.invoke('delete-saved-search', id),

  // ============================================================================
  // ACTIVITY LOG
  // ============================================================================
  getRecentActivity: (limit?: number) =>
    ipcRenderer.invoke('get-recent-activity', limit),
  logActivity: (type: string, sessionId: string | null, description: string, metadata?: unknown) =>
    ipcRenderer.invoke('log-activity', { type, sessionId, description, metadata }),
  clearActivityLog: () =>
    ipcRenderer.invoke('clear-activity-log'),
};
