// ============================================================================
// DATABASE IPC HANDLERS
// ============================================================================
//
// Handles IPC for collections, tags, prompts, notes, notifications,
// knowledge base, search, analytics, and activity logging.
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as db from '../../database/index.js';
import * as collections from '../../database/collections.js';
import * as prompts from '../../database/prompts.js';
import * as notes from '../../database/notes.js';
import * as notifications from '../../database/notifications.js';
import * as knowledge from '../../database/knowledge.js';
import * as search from '../../database/search.js';
import type { SmartCollectionRule, SearchOptions } from '../../../shared/types/index.js';

const logger = new Logger('IPC:Database');

export function registerDatabaseHandlers(): void {
  // ============================================================================
  // ANALYTICS HANDLERS
  // ============================================================================

  ipcMain.handle('get-analytics', withContext('get-analytics', async () => {
    return db.getAnalytics();
  }));

  ipcMain.handle('get-tool-usage', withContext('get-tool-usage', async () => {
    return db.getToolUsageStats();
  }));

  // ============================================================================
  // COLLECTION HANDLERS
  // ============================================================================

  ipcMain.handle('get-collections', withContext('get-collections', async () => {
    return collections.getAllCollections();
  }));

  ipcMain.handle('create-collection', withContext('create-collection', async (_, { name, color, icon }: { name: string; color?: string; icon?: string }) => {
    return collections.createCollection(name, color, icon);
  }));

  ipcMain.handle('update-collection', withContext('update-collection', async (_, { id, name, color, icon }: { id: number; name: string; color: string; icon: string }) => {
    collections.updateCollection(id, name, color, icon);
    return true;
  }));

  ipcMain.handle('delete-collection', withContext('delete-collection', async (_, id: number) => {
    collections.deleteCollection(id);
    return true;
  }));

  ipcMain.handle('add-session-to-collection', withContext('add-session-to-collection', async (_, { sessionId, collectionId }: { sessionId: string; collectionId: number }) => {
    collections.addSessionToCollection(sessionId, collectionId);
    return true;
  }));

  // Smart collections
  ipcMain.handle('get-smart-collections', withContext('get-smart-collections', async () => {
    return collections.getAllSmartCollections();
  }));

  ipcMain.handle('create-smart-collection', withContext('create-smart-collection', async (_, { name, rules, color, icon, matchMode }: { name: string; rules: SmartCollectionRule[]; color?: string; icon?: string; matchMode?: 'all' | 'any' }) => {
    return collections.createSmartCollection(name, rules, color, icon, matchMode);
  }));

  ipcMain.handle('get-smart-collection-sessions', withContext('get-smart-collection-sessions', async (_, id: number) => {
    return collections.getSessionsForSmartCollection(id);
  }));

  ipcMain.handle('delete-smart-collection', withContext('delete-smart-collection', async (_, id: number) => {
    collections.deleteSmartCollection(id);
    return true;
  }));

  // ============================================================================
  // TAG HANDLERS
  // ============================================================================

  ipcMain.handle('get-tags', withContext('get-tags', async () => {
    return db.getAllTags();
  }));

  ipcMain.handle('create-tag', withContext('create-tag', async (_, { name, color }: { name: string; color: string }) => {
    db.createTag(name, color);
    return true;
  }));

  ipcMain.handle('delete-tag', withContext('delete-tag', async (_, id: number) => {
    db.deleteTag(id);
    return true;
  }));

  ipcMain.handle('add-tag-to-session', withContext('add-tag-to-session', async (_, { sessionId, tagId }: { sessionId: string; tagId: number }) => {
    db.addTagToSession(sessionId, tagId);
    return true;
  }));

  ipcMain.handle('remove-tag-from-session', withContext('remove-tag-from-session', async (_, { sessionId, tagId }: { sessionId: string; tagId: number }) => {
    db.removeTagFromSession(sessionId, tagId);
    return true;
  }));

  ipcMain.handle('get-session-tags', withContext('get-session-tags', async (_, sessionId: string) => {
    return db.getSessionTags(sessionId);
  }));

  // ============================================================================
  // PROMPT HANDLERS
  // ============================================================================

  ipcMain.handle('get-prompts', withContext('get-prompts', async () => {
    return prompts.getAllPrompts();
  }));

  ipcMain.handle('save-prompt', withContext('save-prompt', async (_, { title, content, category }: { title: string; content: string; category?: string }) => {
    return prompts.savePrompt(title, content, category);
  }));

  ipcMain.handle('use-prompt', withContext('use-prompt', async (_, id: number) => {
    prompts.usePrompt(id);
    return true;
  }));

  ipcMain.handle('delete-prompt', withContext('delete-prompt', async (_, id: number) => {
    prompts.deletePrompt(id);
    return true;
  }));

  // ============================================================================
  // NOTES HANDLERS
  // ============================================================================

  ipcMain.handle('get-quick-notes', withContext('get-quick-notes', async (_, status: string) => {
    return notes.getQuickNotes(status);
  }));

  ipcMain.handle('create-quick-note', withContext('create-quick-note', async (_, { content, sessionId, priority }: { content: string; sessionId?: string; priority?: string }) => {
    return notes.createQuickNote(content, sessionId, priority);
  }));

  ipcMain.handle('update-quick-note', withContext('update-quick-note', async (_, { id, content }: { id: number; content: string }) => {
    notes.updateQuickNote(id, content);
    return true;
  }));

  ipcMain.handle('set-quick-note-status', withContext('set-quick-note-status', async (_, { id, status }: { id: number; status: string }) => {
    notes.setQuickNoteStatus(id, status);
    return true;
  }));

  ipcMain.handle('delete-quick-note', withContext('delete-quick-note', async (_, id: number) => {
    notes.deleteQuickNote(id);
    return true;
  }));

  // ============================================================================
  // NOTIFICATION HANDLERS
  // ============================================================================

  ipcMain.handle('get-notifications', withContext('get-notifications', async (_, { includeRead, limit }: { includeRead?: boolean; limit?: number }) => {
    return notifications.getNotifications(includeRead, limit);
  }));

  ipcMain.handle('get-unread-notification-count', withContext('get-unread-notification-count', async () => {
    return notifications.getUnreadNotificationCount();
  }));

  ipcMain.handle('mark-notification-read', withContext('mark-notification-read', async (_, id: number) => {
    notifications.markNotificationRead(id);
    return true;
  }));

  ipcMain.handle('mark-all-notifications-read', withContext('mark-all-notifications-read', async () => {
    notifications.markAllNotificationsRead();
    return true;
  }));

  ipcMain.handle('dismiss-all-notifications', withContext('dismiss-all-notifications', async () => {
    notifications.dismissAllNotifications();
    return true;
  }));

  // ============================================================================
  // KNOWLEDGE HANDLERS
  // ============================================================================

  ipcMain.handle('get-all-knowledge-entries', withContext('get-all-knowledge-entries', async () => {
    return knowledge.getAllKnowledgeEntries();
  }));

  ipcMain.handle('get-knowledge-entry', withContext('get-knowledge-entry', async (_, id: number) => {
    return knowledge.getKnowledgeEntry(id);
  }));

  ipcMain.handle('create-knowledge-entry', withContext('create-knowledge-entry', async (_, { title, content, category, tags }: { title: string; content: string; category?: string; tags?: string }) => {
    return knowledge.createKnowledgeEntry(title, content, category, tags);
  }));

  ipcMain.handle('update-knowledge-entry', withContext('update-knowledge-entry', async (_, { id, title, content, category, tags }: { id: number; title: string; content: string; category?: string; tags?: string }) => {
    knowledge.updateKnowledgeEntry(id, title, content, category, tags);
    return true;
  }));

  ipcMain.handle('delete-knowledge-entry', withContext('delete-knowledge-entry', async (_, id: number) => {
    knowledge.deleteKnowledgeEntry(id);
    return true;
  }));

  ipcMain.handle('search-knowledge', withContext('search-knowledge', async (_, term: string) => {
    return knowledge.searchKnowledge(term);
  }));

  // ============================================================================
  // SEARCH HANDLERS
  // ============================================================================

  ipcMain.handle('search-sessions', withContext('search-sessions', async (_, query: string) => {
    return search.searchSessions(query);
  }));

  ipcMain.handle('search-sessions-advanced', withContext('search-sessions-advanced', async (_, options: SearchOptions) => {
    return search.searchSessionsAdvanced(options);
  }));

  ipcMain.handle('save-search', withContext('save-search', async (_, { name, query, filters }: { name: string; query: string; filters?: Record<string, unknown> }) => {
    return search.saveSearch(name, query, filters);
  }));

  ipcMain.handle('get-saved-searches', withContext('get-saved-searches', async () => {
    return search.getAllSavedSearches();
  }));

  ipcMain.handle('delete-saved-search', withContext('delete-saved-search', async (_, id: number) => {
    search.deleteSavedSearch(id);
    return true;
  }));

  // ============================================================================
  // ACTIVITY LOG HANDLERS
  // ============================================================================

  ipcMain.handle('get-recent-activity', withContext('get-recent-activity', async (_, limit?: number) => {
    return db.getRecentActivity(limit);
  }));

  ipcMain.handle('log-activity', withContext('log-activity', async (_, { type, sessionId, description, metadata }: { type: string; sessionId: string | null; description: string; metadata?: unknown }) => {
    db.logActivity(type, sessionId, description, metadata);
    return true;
  }));

  ipcMain.handle('clear-activity-log', withContext('clear-activity-log', async () => {
    db.clearActivityLog();
    return true;
  }));

  logger.info('Database handlers registered');
}
