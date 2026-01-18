// ============================================================================
// DATABASE IPC HANDLERS
// ============================================================================
//
// Handles IPC for collections, tags, prompts, notes, notifications,
// knowledge base, search, analytics, and activity logging.
//
// All handlers use Zod validation for input sanitization.
// ============================================================================

import { ipcMain } from 'electron';
import { ZodError } from 'zod';
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
import {
  numericIdSchema,
  sessionIdSchema,
} from '../schemas/primitives.js';
import {
  createCollectionSchema,
  updateCollectionSchema,
  sessionCollectionSchema,
  createSmartCollectionSchema,
} from '../schemas/collections.js';
import {
  createTagSchema,
  sessionTagSchema,
} from '../schemas/tags.js';
import { savePromptSchema } from '../schemas/prompts.js';
import {
  createQuickNoteSchema,
  updateQuickNoteSchema,
  setQuickNoteStatusSchema,
  noteStatusQuerySchema,
} from '../schemas/notes.js';
import { getNotificationsSchema } from '../schemas/notifications.js';
import {
  createKnowledgeEntrySchema,
  updateKnowledgeEntrySchema,
} from '../schemas/knowledge.js';
import {
  searchQuerySchema,
  advancedSearchOptionsSchema,
  saveSearchSchema,
} from '../schemas/search.js';
import { logActivitySchema, activityLimitSchema } from '../schemas/export.js';

const logger = new Logger('IPC:Database');

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

  ipcMain.handle('create-collection', withContext('create-collection', async (_, data: unknown) => {
    const validation = validateInput(createCollectionSchema, data, 'create-collection');
    if (!validation.success) return validation.error;
    const { name, color, icon } = validation.data;
    return collections.createCollection(name, color, icon);
  }));

  ipcMain.handle('update-collection', withContext('update-collection', async (_, data: unknown) => {
    const validation = validateInput(updateCollectionSchema, data, 'update-collection');
    if (!validation.success) return validation.error;
    const { id, name, color, icon } = validation.data;
    collections.updateCollection(id, name, color, icon);
    return true;
  }));

  ipcMain.handle('delete-collection', withContext('delete-collection', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'delete-collection');
    if (!validation.success) return validation.error;
    collections.deleteCollection(validation.data);
    return true;
  }));

  ipcMain.handle('add-session-to-collection', withContext('add-session-to-collection', async (_, data: unknown) => {
    const validation = validateInput(sessionCollectionSchema, data, 'add-session-to-collection');
    if (!validation.success) return validation.error;
    const { sessionId, collectionId } = validation.data;
    collections.addSessionToCollection(sessionId, collectionId);
    return true;
  }));

  // Smart collections
  ipcMain.handle('get-smart-collections', withContext('get-smart-collections', async () => {
    return collections.getAllSmartCollections();
  }));

  ipcMain.handle('create-smart-collection', withContext('create-smart-collection', async (_, data: unknown) => {
    const validation = validateInput(createSmartCollectionSchema, data, 'create-smart-collection');
    if (!validation.success) return validation.error;
    const { name, rules, color, icon, matchMode } = validation.data;
    return collections.createSmartCollection(name, rules as SmartCollectionRule[], color, icon, matchMode);
  }));

  ipcMain.handle('get-smart-collection-sessions', withContext('get-smart-collection-sessions', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'get-smart-collection-sessions');
    if (!validation.success) return validation.error;
    return collections.getSessionsForSmartCollection(validation.data);
  }));

  ipcMain.handle('delete-smart-collection', withContext('delete-smart-collection', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'delete-smart-collection');
    if (!validation.success) return validation.error;
    collections.deleteSmartCollection(validation.data);
    return true;
  }));

  // ============================================================================
  // TAG HANDLERS
  // ============================================================================

  ipcMain.handle('get-tags', withContext('get-tags', async () => {
    return db.getAllTags();
  }));

  ipcMain.handle('create-tag', withContext('create-tag', async (_, data: unknown) => {
    const validation = validateInput(createTagSchema, data, 'create-tag');
    if (!validation.success) return validation.error;
    const { name, color } = validation.data;
    db.createTag(name, color);
    return true;
  }));

  ipcMain.handle('delete-tag', withContext('delete-tag', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'delete-tag');
    if (!validation.success) return validation.error;
    db.deleteTag(validation.data);
    return true;
  }));

  ipcMain.handle('add-tag-to-session', withContext('add-tag-to-session', async (_, data: unknown) => {
    const validation = validateInput(sessionTagSchema, data, 'add-tag-to-session');
    if (!validation.success) return validation.error;
    const { sessionId, tagId } = validation.data;
    db.addTagToSession(sessionId, tagId);
    return true;
  }));

  ipcMain.handle('remove-tag-from-session', withContext('remove-tag-from-session', async (_, data: unknown) => {
    const validation = validateInput(sessionTagSchema, data, 'remove-tag-from-session');
    if (!validation.success) return validation.error;
    const { sessionId, tagId } = validation.data;
    db.removeTagFromSession(sessionId, tagId);
    return true;
  }));

  ipcMain.handle('get-session-tags', withContext('get-session-tags', async (_, sessionId: unknown) => {
    const validation = validateInput(sessionIdSchema, sessionId, 'get-session-tags');
    if (!validation.success) return validation.error;
    return db.getSessionTags(validation.data);
  }));

  // ============================================================================
  // PROMPT HANDLERS
  // ============================================================================

  ipcMain.handle('get-prompts', withContext('get-prompts', async () => {
    return prompts.getAllPrompts();
  }));

  ipcMain.handle('save-prompt', withContext('save-prompt', async (_, data: unknown) => {
    const validation = validateInput(savePromptSchema, data, 'save-prompt');
    if (!validation.success) return validation.error;
    const { title, content, category } = validation.data;
    return prompts.savePrompt(title, content, category);
  }));

  ipcMain.handle('use-prompt', withContext('use-prompt', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'use-prompt');
    if (!validation.success) return validation.error;
    prompts.usePrompt(validation.data);
    return true;
  }));

  ipcMain.handle('delete-prompt', withContext('delete-prompt', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'delete-prompt');
    if (!validation.success) return validation.error;
    prompts.deletePrompt(validation.data);
    return true;
  }));

  // ============================================================================
  // NOTES HANDLERS
  // ============================================================================

  ipcMain.handle('get-quick-notes', withContext('get-quick-notes', async (_, status: unknown) => {
    const validation = validateInput(noteStatusQuerySchema, status, 'get-quick-notes');
    if (!validation.success) return validation.error;
    return notes.getQuickNotes(validation.data);
  }));

  ipcMain.handle('create-quick-note', withContext('create-quick-note', async (_, data: unknown) => {
    const validation = validateInput(createQuickNoteSchema, data, 'create-quick-note');
    if (!validation.success) return validation.error;
    const { content, sessionId, priority } = validation.data;
    return notes.createQuickNote(content, sessionId, priority);
  }));

  ipcMain.handle('update-quick-note', withContext('update-quick-note', async (_, data: unknown) => {
    const validation = validateInput(updateQuickNoteSchema, data, 'update-quick-note');
    if (!validation.success) return validation.error;
    const { id, content } = validation.data;
    notes.updateQuickNote(id, content);
    return true;
  }));

  ipcMain.handle('set-quick-note-status', withContext('set-quick-note-status', async (_, data: unknown) => {
    const validation = validateInput(setQuickNoteStatusSchema, data, 'set-quick-note-status');
    if (!validation.success) return validation.error;
    const { id, status } = validation.data;
    notes.setQuickNoteStatus(id, status);
    return true;
  }));

  ipcMain.handle('delete-quick-note', withContext('delete-quick-note', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'delete-quick-note');
    if (!validation.success) return validation.error;
    notes.deleteQuickNote(validation.data);
    return true;
  }));

  // ============================================================================
  // NOTIFICATION HANDLERS
  // ============================================================================

  ipcMain.handle('get-notifications', withContext('get-notifications', async (_, data: unknown) => {
    const validation = validateInput(getNotificationsSchema, data, 'get-notifications');
    if (!validation.success) return validation.error;
    const { includeRead, limit } = validation.data;
    return notifications.getNotifications(includeRead, limit);
  }));

  ipcMain.handle('get-unread-notification-count', withContext('get-unread-notification-count', async () => {
    return notifications.getUnreadNotificationCount();
  }));

  ipcMain.handle('mark-notification-read', withContext('mark-notification-read', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'mark-notification-read');
    if (!validation.success) return validation.error;
    notifications.markNotificationRead(validation.data);
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

  ipcMain.handle('get-knowledge-entry', withContext('get-knowledge-entry', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'get-knowledge-entry');
    if (!validation.success) return validation.error;
    return knowledge.getKnowledgeEntry(validation.data);
  }));

  ipcMain.handle('create-knowledge-entry', withContext('create-knowledge-entry', async (_, data: unknown) => {
    const validation = validateInput(createKnowledgeEntrySchema, data, 'create-knowledge-entry');
    if (!validation.success) return validation.error;
    const { title, content, category, tags } = validation.data;
    return knowledge.createKnowledgeEntry(title, content, category, tags);
  }));

  ipcMain.handle('update-knowledge-entry', withContext('update-knowledge-entry', async (_, data: unknown) => {
    const validation = validateInput(updateKnowledgeEntrySchema, data, 'update-knowledge-entry');
    if (!validation.success) return validation.error;
    const { id, title, content, category, tags } = validation.data;
    knowledge.updateKnowledgeEntry(id, title, content, category, tags);
    return true;
  }));

  ipcMain.handle('delete-knowledge-entry', withContext('delete-knowledge-entry', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'delete-knowledge-entry');
    if (!validation.success) return validation.error;
    knowledge.deleteKnowledgeEntry(validation.data);
    return true;
  }));

  ipcMain.handle('search-knowledge', withContext('search-knowledge', async (_, term: unknown) => {
    const validation = validateInput(searchQuerySchema, term, 'search-knowledge');
    if (!validation.success) return validation.error;
    return knowledge.searchKnowledge(validation.data);
  }));

  // ============================================================================
  // SEARCH HANDLERS
  // ============================================================================

  ipcMain.handle('search-sessions', withContext('search-sessions', async (_, query: unknown) => {
    const validation = validateInput(searchQuerySchema, query, 'search-sessions');
    if (!validation.success) return validation.error;
    return search.searchSessions(validation.data);
  }));

  ipcMain.handle('search-sessions-advanced', withContext('search-sessions-advanced', async (_, options: unknown) => {
    const validation = validateInput(advancedSearchOptionsSchema, options, 'search-sessions-advanced');
    if (!validation.success) return validation.error;
    return search.searchSessionsAdvanced(validation.data as SearchOptions);
  }));

  ipcMain.handle('save-search', withContext('save-search', async (_, data: unknown) => {
    const validation = validateInput(saveSearchSchema, data, 'save-search');
    if (!validation.success) return validation.error;
    const { name, query, filters } = validation.data;
    return search.saveSearch(name, query, filters);
  }));

  ipcMain.handle('get-saved-searches', withContext('get-saved-searches', async () => {
    return search.getAllSavedSearches();
  }));

  ipcMain.handle('delete-saved-search', withContext('delete-saved-search', async (_, id: unknown) => {
    const validation = validateInput(numericIdSchema, id, 'delete-saved-search');
    if (!validation.success) return validation.error;
    search.deleteSavedSearch(validation.data);
    return true;
  }));

  // ============================================================================
  // ACTIVITY LOG HANDLERS
  // ============================================================================

  ipcMain.handle('get-recent-activity', withContext('get-recent-activity', async (_, limit: unknown) => {
    const validation = validateInput(activityLimitSchema, limit, 'get-recent-activity');
    if (!validation.success) return validation.error;
    return db.getRecentActivity(validation.data);
  }));

  ipcMain.handle('log-activity', withContext('log-activity', async (_, data: unknown) => {
    const validation = validateInput(logActivitySchema, data, 'log-activity');
    if (!validation.success) return validation.error;
    const { type, sessionId, description, metadata } = validation.data;
    db.logActivity(type, sessionId, description, metadata);
    return true;
  }));

  ipcMain.handle('clear-activity-log', withContext('clear-activity-log', async () => {
    db.clearActivityLog();
    return true;
  }));

  logger.info('Database handlers registered (with Zod validation)');
}
