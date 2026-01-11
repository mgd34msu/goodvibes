// ============================================================================
// IPC HANDLER REGISTRATION
// ============================================================================

import { ipcMain, dialog, app, shell, clipboard, Menu, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';

import { Logger } from '../services/logger.js';
import { createRequestContext, runWithContextAsync } from '../services/requestContext.js';
import { registerPhase5to8Handlers } from './phase5to8Handlers.js';
import { registerPhase9to12Handlers } from './phase9to12Handlers.js';
import { initProjectRegistry } from '../services/projectRegistry.js';
import { initProjectCoordinator } from '../services/projectCoordinator.js';
import { startTerminal, startPlainTerminal, writeToTerminal, resizeTerminal, killTerminal, getAllTerminals } from '../services/terminalManager.js';
import { getSessionManager } from '../services/sessionManager.js';
import { getRecentProjects, addRecentProject, removeRecentProject, clearRecentProjects, pinProject } from '../services/recentProjects.js';
import * as git from '../services/git.js';
import * as db from '../database/index.js';
import * as collections from '../database/collections.js';
import * as prompts from '../database/prompts.js';
import * as notes from '../database/notes.js';
import * as notifications from '../database/notifications.js';
import * as knowledge from '../database/knowledge.js';
import * as search from '../database/search.js';
import * as primitives from '../database/primitives.js';
import * as hookEvents from '../database/hookEvents.js';
import { getHookServer, getHookServerStatus, startHookServer, stopHookServer } from '../services/hookServer.js';
import {
  installAllHookScripts,
  areHookScriptsInstalled,
  getInstalledHookScripts,
  validateAllHookScripts,
  generateClaudeHooksConfig,
  HOOKS_DIR,
} from '../services/hookScripts.js';
import * as agencyIndex from '../database/agencyIndex.js';
import { initializeAgentIndexer, getAgentIndexer } from '../services/agentIndexer.js';
import { initializeSkillIndexer, getSkillIndexer } from '../services/skillIndexer.js';
import { getContextInjectionService, initializeContextInjectionService } from '../services/contextInjection.js';

const logger = new Logger('IPC');

// ============================================================================
// REQUEST CONTEXT WRAPPER
// ============================================================================

/**
 * Wraps an IPC handler with request context for correlation logging.
 * This enables tracking requests through the entire application stack.
 *
 * @param operation - The name of the IPC operation (e.g., 'get-sessions')
 * @param handler - The handler function to wrap
 * @returns A wrapped handler that runs within a request context
 */
function withContext<TArgs extends unknown[], TReturn>(
  operation: string,
  handler: (...args: TArgs) => Promise<TReturn>
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const context = createRequestContext(operation);
    return runWithContextAsync(context, () => handler(...args));
  };
}

export function registerAllIpcHandlers(): void {
  // ============================================================================
  // TERMINAL HANDLERS
  // ============================================================================

  ipcMain.handle('start-claude', withContext('start-claude', async (_, options: { cwd?: string; name?: string; resumeSessionId?: string; sessionType?: 'user' | 'subagent' }) => {
    logger.info('IPC: start-claude received', {
      cwd: options.cwd,
      name: options.name,
      resumeSessionId: options.resumeSessionId,
      sessionType: options.sessionType
    });
    return startTerminal(options);
  }));

  ipcMain.handle('start-plain-terminal', withContext('start-plain-terminal', async (_, options: { cwd?: string; name?: string }) => {
    logger.info('IPC: start-plain-terminal received', {
      cwd: options.cwd,
      name: options.name
    });
    return startPlainTerminal(options);
  }));

  ipcMain.handle('terminal-input', withContext('terminal-input', async (_, { id, data }) => {
    writeToTerminal(id, data);
    return true;
  }));

  ipcMain.handle('terminal-resize', withContext('terminal-resize', async (_, { id, cols, rows }) => {
    resizeTerminal(id, cols, rows);
    return true;
  }));

  ipcMain.handle('kill-terminal', withContext('kill-terminal', async (_, id) => {
    return killTerminal(id);
  }));

  ipcMain.handle('get-terminals', withContext('get-terminals', async () => {
    return getAllTerminals();
  }));

  // ============================================================================
  // SESSION HANDLERS
  // ============================================================================

  ipcMain.handle('get-sessions', withContext('get-sessions', async () => {
    const sessionManager = getSessionManager();
    return sessionManager?.getAllSessions() ?? [];
  }));

  ipcMain.handle('get-session', withContext('get-session', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return sessionManager?.getSession(id) ?? null;
  }));

  ipcMain.handle('get-session-messages', withContext('get-session-messages', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return await sessionManager?.getSessionMessages(id) ?? [];
  }));

  ipcMain.handle('get-active-sessions', withContext('get-active-sessions', async () => {
    return db.getActiveSessions();
  }));

  ipcMain.handle('get-favorite-sessions', withContext('get-favorite-sessions', async () => {
    return db.getFavoriteSessions();
  }));

  ipcMain.handle('get-archived-sessions', withContext('get-archived-sessions', async () => {
    return db.getArchivedSessions();
  }));

  ipcMain.handle('toggle-favorite', withContext('toggle-favorite', async (_, id: string) => {
    db.toggleFavorite(id);
    return true;
  }));

  ipcMain.handle('toggle-archive', withContext('toggle-archive', async (_, id: string) => {
    db.toggleArchive(id);
    return true;
  }));

  ipcMain.handle('delete-session', withContext('delete-session', async (_, id: string) => {
    db.deleteSession(id);
    return true;
  }));

  ipcMain.handle('get-live-sessions', withContext('get-live-sessions', async () => {
    const sessionManager = getSessionManager();
    return sessionManager?.getLiveSessions() ?? [];
  }));

  ipcMain.handle('get-session-raw-entries', withContext('get-session-raw-entries', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return await sessionManager?.getSessionRawEntries(id) ?? [];
  }));

  ipcMain.handle('refresh-session', withContext('refresh-session', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return await sessionManager?.refreshSessionTokens(id) ?? null;
  }));

  ipcMain.handle('is-session-live', withContext('is-session-live', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return sessionManager?.isSessionLive(id) ?? false;
  }));

  ipcMain.handle('recalculate-session-costs', withContext('recalculate-session-costs', async () => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      return { success: false, error: 'Session manager not initialized', count: 0 };
    }
    try {
      const count = await sessionManager.recalculateAllCosts();
      return { success: true, count };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error', count: 0 };
    }
  }));

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
  // SETTINGS HANDLERS
  // ============================================================================

  ipcMain.handle('get-setting', withContext('get-setting', async (_, key: string) => {
    return db.getSetting(key);
  }));

  ipcMain.handle('set-setting', withContext('set-setting', async (_, { key, value }: { key: string; value: unknown }) => {
    db.setSetting(key, value);
    return true;
  }));

  ipcMain.handle('get-all-settings', withContext('get-all-settings', async () => {
    return db.getAllSettings();
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

  ipcMain.handle('create-smart-collection', withContext('create-smart-collection', async (_, { name, rules, color, icon, matchMode }: { name: string; rules: import('../../shared/types/index.js').SmartCollectionRule[]; color?: string; icon?: string; matchMode?: 'all' | 'any' }) => {
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

  ipcMain.handle('search-sessions-advanced', withContext('search-sessions-advanced', async (_, options: import('../../shared/types/index.js').SearchOptions) => {
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
  // GIT HANDLERS
  // ============================================================================

  // Basic git operations (wrapped with context for tracing)
  ipcMain.handle('git-status', withContext('git-status', async (_, cwd: string) => git.gitStatus(cwd)));
  ipcMain.handle('git-branch', withContext('git-branch', async (_, cwd: string) => git.gitBranch(cwd)));
  ipcMain.handle('git-log', withContext('git-log', async (_, cwd: string) => git.gitLog(cwd)));
  ipcMain.handle('git-diff', withContext('git-diff', async (_, { cwd, staged }: { cwd: string; staged?: boolean }) => git.gitDiff(cwd, staged)));
  ipcMain.handle('git-add', withContext('git-add', async (_, { cwd, files }: { cwd: string; files?: string }) => git.gitAdd(cwd, files)));
  ipcMain.handle('git-commit', withContext('git-commit', async (_, { cwd, message }: { cwd: string; message: string }) => git.gitCommit(cwd, message)));
  ipcMain.handle('git-push', withContext('git-push', async (_, cwd: string) => git.gitPush(cwd)));
  ipcMain.handle('git-pull', withContext('git-pull', async (_, cwd: string) => git.gitPull(cwd)));
  ipcMain.handle('git-is-repo', withContext('git-is-repo', async (_, cwd: string) => git.gitIsRepo(cwd)));
  ipcMain.handle('git-stash', withContext('git-stash', async (_, { cwd, action }: { cwd: string; action?: 'pop' | 'list' }) => git.gitStash(cwd, action)));
  ipcMain.handle('git-init', withContext('git-init', async (_, cwd: string) => git.gitInit(cwd)));
  ipcMain.handle('git-reset', withContext('git-reset', async (_, { cwd, files }: { cwd: string; files?: string[] }) => git.gitReset(cwd, files)));
  ipcMain.handle('git-fetch', withContext('git-fetch', async (_, cwd: string) => git.gitFetch(cwd)));

  // Enhanced git operations for full-featured Git panel
  ipcMain.handle('git-detailed-status', withContext('git-detailed-status', async (_, cwd: string) => git.gitDetailedStatus(cwd)));
  ipcMain.handle('git-branches', withContext('git-branches', async (_, cwd: string) => git.gitBranches(cwd)));
  ipcMain.handle('git-checkout', withContext('git-checkout', async (_, { cwd, branch }: { cwd: string; branch: string }) => git.gitCheckout(cwd, branch)));
  ipcMain.handle('git-create-branch', withContext('git-create-branch', async (_, { cwd, name, checkout }: { cwd: string; name: string; checkout?: boolean }) => git.gitCreateBranch(cwd, name, checkout)));
  ipcMain.handle('git-stage', withContext('git-stage', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitStage(cwd, files)));
  ipcMain.handle('git-unstage', withContext('git-unstage', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitUnstage(cwd, files)));
  ipcMain.handle('git-log-detailed', withContext('git-log-detailed', async (_, { cwd, limit }: { cwd: string; limit?: number }) => git.gitLogDetailed(cwd, limit)));
  ipcMain.handle('git-ahead-behind', withContext('git-ahead-behind', async (_, cwd: string) => git.gitAheadBehind(cwd)));
  ipcMain.handle('git-discard-changes', withContext('git-discard-changes', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitDiscardChanges(cwd, files)));
  ipcMain.handle('git-clean-file', withContext('git-clean-file', async (_, { cwd, file }: { cwd: string; file: string }) => git.gitCleanFile(cwd, file)));
  ipcMain.handle('git-show-commit', withContext('git-show-commit', async (_, { cwd, hash }: { cwd: string; hash: string }) => git.gitShowCommit(cwd, hash)));
  ipcMain.handle('git-file-diff', withContext('git-file-diff', async (_, { cwd, file, options }: { cwd: string; file?: string; options?: { staged?: boolean; commit?: string } }) => git.gitFileDiff(cwd, file, options)));
  ipcMain.handle('git-diff-raw', withContext('git-diff-raw', async (_, { cwd, options }: { cwd: string; options?: { staged?: boolean; file?: string; commit?: string } }) => git.gitDiffRaw(cwd, options)));
  ipcMain.handle('git-branches-with-hierarchy', withContext('git-branches-with-hierarchy', async (_, cwd: string) => git.gitBranchesWithHierarchy(cwd)));

  // Merge operations
  ipcMain.handle('git-merge', withContext('git-merge', async (_, { cwd, branch, options }: { cwd: string; branch: string; options?: { noFf?: boolean; squash?: boolean } }) => git.gitMerge(cwd, branch, options)));
  ipcMain.handle('git-merge-abort', withContext('git-merge-abort', async (_, cwd: string) => git.gitMergeAbort(cwd)));
  ipcMain.handle('git-merge-in-progress', withContext('git-merge-in-progress', async (_, cwd: string) => git.gitMergeInProgress(cwd)));

  // Remote operations
  ipcMain.handle('git-remotes', withContext('git-remotes', async (_, cwd: string) => git.gitRemotes(cwd)));
  ipcMain.handle('git-remote-add', withContext('git-remote-add', async (_, { cwd, name, url }: { cwd: string; name: string; url: string }) => git.gitRemoteAdd(cwd, name, url)));
  ipcMain.handle('git-remote-remove', withContext('git-remote-remove', async (_, { cwd, name }: { cwd: string; name: string }) => git.gitRemoteRemove(cwd, name)));

  // Stash operations
  ipcMain.handle('git-stash-list', withContext('git-stash-list', async (_, cwd: string) => git.gitStashList(cwd)));
  ipcMain.handle('git-stash-push', withContext('git-stash-push', async (_, { cwd, message }: { cwd: string; message?: string }) => git.gitStashPush(cwd, message)));
  ipcMain.handle('git-stash-pop', withContext('git-stash-pop', async (_, { cwd, index }: { cwd: string; index?: number }) => git.gitStashPop(cwd, index)));
  ipcMain.handle('git-stash-apply', withContext('git-stash-apply', async (_, { cwd, index }: { cwd: string; index?: number }) => git.gitStashApply(cwd, index)));
  ipcMain.handle('git-stash-drop', withContext('git-stash-drop', async (_, { cwd, index }: { cwd: string; index?: number }) => git.gitStashDrop(cwd, index)));

  // Branch deletion
  ipcMain.handle('git-delete-branch', withContext('git-delete-branch', async (_, { cwd, branch, options }: { cwd: string; branch: string; options?: { force?: boolean } }) => git.gitDeleteBranch(cwd, branch, options)));
  ipcMain.handle('git-delete-remote-branch', withContext('git-delete-remote-branch', async (_, { cwd, remote, branch }: { cwd: string; remote: string; branch: string }) => git.gitDeleteRemoteBranch(cwd, remote, branch)));

  // Commit amend
  ipcMain.handle('git-commit-amend', withContext('git-commit-amend', async (_, { cwd, options }: { cwd: string; options?: { message?: string; noEdit?: boolean } }) => git.gitCommitAmend(cwd, options)));

  // Cherry-pick
  ipcMain.handle('git-cherry-pick', withContext('git-cherry-pick', async (_, { cwd, commit }: { cwd: string; commit: string }) => git.gitCherryPick(cwd, commit)));
  ipcMain.handle('git-cherry-pick-abort', withContext('git-cherry-pick-abort', async (_, cwd: string) => git.gitCherryPickAbort(cwd)));
  ipcMain.handle('git-cherry-pick-continue', withContext('git-cherry-pick-continue', async (_, cwd: string) => git.gitCherryPickContinue(cwd)));
  ipcMain.handle('git-cherry-pick-in-progress', withContext('git-cherry-pick-in-progress', async (_, cwd: string) => git.gitCherryPickInProgress(cwd)));

  // Hunk/line staging
  ipcMain.handle('git-apply-patch', withContext('git-apply-patch', async (_, { cwd, patch, options }: { cwd: string; patch: string; options?: { cached?: boolean; reverse?: boolean } }) => git.gitApplyPatch(cwd, patch, options)));
  ipcMain.handle('git-diff-for-staging', withContext('git-diff-for-staging', async (_, { cwd, file, staged }: { cwd: string; file: string; staged?: boolean }) => git.gitDiffForStaging(cwd, file, staged)));

  // Git blame
  ipcMain.handle('git-blame', withContext('git-blame', async (_, { cwd, file, options }: { cwd: string; file: string; options?: { startLine?: number; endLine?: number } }) => git.gitBlame(cwd, file, options)));

  // Tag management
  ipcMain.handle('git-tags', withContext('git-tags', async (_, cwd: string) => git.gitTags(cwd)));
  ipcMain.handle('git-create-tag', withContext('git-create-tag', async (_, { cwd, name, options }: { cwd: string; name: string; options?: { message?: string; commit?: string } }) => git.gitCreateTag(cwd, name, options)));
  ipcMain.handle('git-delete-tag', withContext('git-delete-tag', async (_, { cwd, name }: { cwd: string; name: string }) => git.gitDeleteTag(cwd, name)));
  ipcMain.handle('git-push-tag', withContext('git-push-tag', async (_, { cwd, name, remote }: { cwd: string; name: string; remote?: string }) => git.gitPushTag(cwd, name, remote)));
  ipcMain.handle('git-push-all-tags', withContext('git-push-all-tags', async (_, { cwd, remote }: { cwd: string; remote?: string }) => git.gitPushAllTags(cwd, remote)));
  ipcMain.handle('git-delete-remote-tag', withContext('git-delete-remote-tag', async (_, { cwd, name, remote }: { cwd: string; name: string; remote?: string }) => git.gitDeleteRemoteTag(cwd, name, remote)));

  // File history
  ipcMain.handle('git-file-history', withContext('git-file-history', async (_, { cwd, file, limit }: { cwd: string; file: string; limit?: number }) => git.gitFileHistory(cwd, file, limit)));
  ipcMain.handle('git-show-file', withContext('git-show-file', async (_, { cwd, file, commit }: { cwd: string; file: string; commit: string }) => git.gitShowFile(cwd, file, commit)));

  // Conflict resolution
  ipcMain.handle('git-conflict-files', withContext('git-conflict-files', async (_, cwd: string) => git.gitConflictFiles(cwd)));
  ipcMain.handle('git-resolve-ours', withContext('git-resolve-ours', async (_, { cwd, file }: { cwd: string; file: string }) => git.gitResolveOurs(cwd, file)));
  ipcMain.handle('git-resolve-theirs', withContext('git-resolve-theirs', async (_, { cwd, file }: { cwd: string; file: string }) => git.gitResolveTheirs(cwd, file)));
  ipcMain.handle('git-mark-resolved', withContext('git-mark-resolved', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitMarkResolved(cwd, files)));

  // Rebase
  ipcMain.handle('git-rebase', withContext('git-rebase', async (_, { cwd, onto }: { cwd: string; onto: string }) => git.gitRebase(cwd, onto)));
  ipcMain.handle('git-rebase-abort', withContext('git-rebase-abort', async (_, cwd: string) => git.gitRebaseAbort(cwd)));
  ipcMain.handle('git-rebase-continue', withContext('git-rebase-continue', async (_, cwd: string) => git.gitRebaseContinue(cwd)));
  ipcMain.handle('git-rebase-skip', withContext('git-rebase-skip', async (_, cwd: string) => git.gitRebaseSkip(cwd)));
  ipcMain.handle('git-rebase-in-progress', withContext('git-rebase-in-progress', async (_, cwd: string) => git.gitRebaseInProgress(cwd)));

  // Reflog
  ipcMain.handle('git-reflog', withContext('git-reflog', async (_, { cwd, limit }: { cwd: string; limit?: number }) => git.gitReflog(cwd, limit)));
  ipcMain.handle('git-reset-to-reflog', withContext('git-reset-to-reflog', async (_, { cwd, index, options }: { cwd: string; index: number; options?: { hard?: boolean; soft?: boolean } }) => git.gitResetToReflog(cwd, index, options)));

  // Submodules
  ipcMain.handle('git-submodules', withContext('git-submodules', async (_, cwd: string) => git.gitSubmodules(cwd)));
  ipcMain.handle('git-submodule-init', withContext('git-submodule-init', async (_, { cwd, path }: { cwd: string; path?: string }) => git.gitSubmoduleInit(cwd, path)));
  ipcMain.handle('git-submodule-update', withContext('git-submodule-update', async (_, { cwd, options }: { cwd: string; options?: { init?: boolean; recursive?: boolean; remote?: boolean; path?: string } }) => git.gitSubmoduleUpdate(cwd, options)));

  // Worktrees
  ipcMain.handle('git-worktrees', withContext('git-worktrees', async (_, cwd: string) => git.gitWorktrees(cwd)));
  ipcMain.handle('git-worktree-add', withContext('git-worktree-add', async (_, { cwd, path, branch, options }: { cwd: string; path: string; branch?: string; options?: { newBranch?: boolean; detach?: boolean } }) => git.gitWorktreeAdd(cwd, path, branch, options)));
  ipcMain.handle('git-worktree-remove', withContext('git-worktree-remove', async (_, { cwd, path, force }: { cwd: string; path: string; force?: boolean }) => git.gitWorktreeRemove(cwd, path, force)));

  // Commit templates
  ipcMain.handle('git-commit-template', withContext('git-commit-template', async (_, cwd: string) => git.gitCommitTemplate(cwd)));
  ipcMain.handle('git-conventional-prefixes', withContext('git-conventional-prefixes', async (_, cwd: string) => git.gitConventionalPrefixes(cwd)));

  // ============================================================================
  // FILE/FOLDER HANDLERS
  // ============================================================================

  ipcMain.handle('select-folder', withContext('select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  }));

  ipcMain.handle('create-folder', withContext('create-folder', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Create New Project Folder',
      buttonLabel: 'Create',
      properties: ['showOverwriteConfirmation'],
    });

    if (!result.canceled && result.filePath) {
      await fs.mkdir(result.filePath, { recursive: true });
      return result.filePath;
    }
    return null;
  }));

  ipcMain.handle('open-in-explorer', withContext('open-in-explorer', async (_, folderPath: string) => {
    shell.showItemInFolder(folderPath);
    return true;
  }));

  // ============================================================================
  // RECENT PROJECTS HANDLERS
  // ============================================================================

  ipcMain.handle('get-recent-projects', withContext('get-recent-projects', async () => {
    return getRecentProjects();
  }));

  ipcMain.handle('add-recent-project', withContext('add-recent-project', async (_, { path: projectPath, name }: { path: string; name?: string }) => {
    addRecentProject(projectPath, name);
    return true;
  }));

  ipcMain.handle('remove-recent-project', withContext('remove-recent-project', async (_, projectPath: string) => {
    removeRecentProject(projectPath);
    return true;
  }));

  ipcMain.handle('pin-project', withContext('pin-project', async (_, projectPath: string) => {
    return pinProject(projectPath);
  }));

  ipcMain.handle('clear-recent-projects', withContext('clear-recent-projects', async () => {
    clearRecentProjects();
    return true;
  }));

  // ============================================================================
  // EXPORT HANDLERS
  // ============================================================================

  ipcMain.handle('export-session', withContext('export-session', async (_, { sessionId, format }: { sessionId: string; format: string }) => {
    const session = db.getSession(sessionId);
    if (!session) return { success: false, error: 'Session not found' };

    const messages = db.getSessionMessages(sessionId);
    const result = await dialog.showSaveDialog({
      title: 'Export Session',
      defaultPath: `session-${sessionId}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    let content: string;

    if (format === 'json') {
      content = JSON.stringify({ session, messages }, null, 2);
    } else if (format === 'markdown') {
      content = formatAsMarkdown(session, messages);
    } else {
      content = formatAsHtml(session, messages);
    }

    await fs.writeFile(result.filePath, content, 'utf-8');
    return { success: true, path: result.filePath };
  }));

  ipcMain.handle('bulk-export', withContext('bulk-export', async (_, sessionIds: string[]) => {
    const result = await dialog.showSaveDialog({
      title: 'Export Sessions as ZIP',
      defaultPath: `sessions-export-${Date.now()}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    const filePath = result.filePath;

    return new Promise((resolve) => {
      const output = createWriteStream(filePath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      // Handle stream events
      output.on('close', () => {
        resolve({ success: true, path: filePath });
      });

      output.on('error', (err) => {
        logger.error('Export write stream error', err);
        resolve({ success: false, error: `Write error: ${err.message}` });
      });

      archive.on('error', (err) => {
        logger.error('Archive error', err);
        output.close();
        resolve({ success: false, error: `Archive error: ${err.message}` });
      });

      archive.pipe(output);

      for (const sessionId of sessionIds) {
        const session = db.getSession(sessionId);
        if (session) {
          const messages = db.getSessionMessages(sessionId);
          archive.append(JSON.stringify({ session, messages }, null, 2), {
            name: `${sessionId}.json`,
          });
        }
      }

      archive.finalize();
    });
  }));

  // ============================================================================
  // APP INFO HANDLERS
  // ============================================================================

  ipcMain.handle('get-app-version', withContext('get-app-version', async () => {
    return app.getVersion();
  }));

  ipcMain.handle('get-app-path', withContext('get-app-path', async (_, name: string) => {
    // Validate the path name against known valid values
    const validPaths = [
      'home', 'appData', 'userData', 'sessionData', 'temp', 'exe',
      'module', 'desktop', 'documents', 'downloads', 'music',
      'pictures', 'videos', 'recent', 'logs', 'crashDumps'
    ] as const;

    type AppPathName = typeof validPaths[number];

    if (!validPaths.includes(name as AppPathName)) {
      throw new Error(`Invalid app path name: ${name}`);
    }

    return app.getPath(name as AppPathName);
  }));

  // ============================================================================
  // ACTIVITY LOG
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

  // ============================================================================
  // GITHUB HANDLERS
  // ============================================================================

  // Authentication - OAuth credentials are bundled with the app
  ipcMain.handle('github-auth', withContext('github-auth', async (_, options?: { scopes?: string[] }) => {
    const github = await import('../services/github.js');
    return github.authenticateWithGitHub(options);
  }));

  ipcMain.handle('github-logout', withContext('github-logout', async () => {
    const github = await import('../services/github.js');
    await github.logout();
    return { success: true };
  }));

  ipcMain.handle('github-is-authenticated', withContext('github-is-authenticated', async () => {
    const github = await import('../services/github.js');
    return github.isAuthenticated();
  }));

  ipcMain.handle('github-get-user', withContext('github-get-user', async () => {
    const github = await import('../services/github.js');
    return github.getCurrentUser();
  }));

  ipcMain.handle('github-get-auth-state', withContext('github-get-auth-state', async () => {
    const github = await import('../services/github.js');
    return github.getAuthState();
  }));

  // Note: github-set-oauth-credentials removed - OAuth credentials are now bundled with the app
  // The setOAuthCredentials function still exists in github.ts for legacy/developer use only

  ipcMain.handle('github-get-oauth-config', withContext('github-get-oauth-config', async () => {
    const github = await import('../services/github.js');
    return github.getOAuthConfig();
  }));

  // Repository operations
  ipcMain.handle('github-list-repos', withContext('github-list-repos', async (_, options?: { sort?: 'created' | 'updated' | 'pushed' | 'full_name'; direction?: 'asc' | 'desc'; per_page?: number; page?: number }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.listUserRepos(options);
  }));

  ipcMain.handle('github-get-repo', withContext('github-get-repo', async (_, { owner, repo }: { owner: string; repo: string }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.getRepo(owner, repo);
  }));

  ipcMain.handle('github-create-repo', withContext('github-create-repo', async (_, { name, options }: { name: string; options?: { description?: string; private?: boolean; auto_init?: boolean } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.createRepo(name, options);
  }));

  ipcMain.handle('github-list-org-repos', withContext('github-list-org-repos', async (_, { org, options }: { org: string; options?: { sort?: 'created' | 'updated' | 'pushed' | 'full_name'; direction?: 'asc' | 'desc'; per_page?: number; page?: number } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.listOrgRepos(org, options);
  }));

  // Pull request operations
  ipcMain.handle('github-list-prs', withContext('github-list-prs', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { state?: 'open' | 'closed' | 'all'; sort?: 'created' | 'updated' | 'popularity' | 'long-running'; direction?: 'asc' | 'desc'; per_page?: number; page?: number } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.listPullRequests(owner, repo, options);
  }));

  ipcMain.handle('github-get-pr', withContext('github-get-pr', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.getPullRequest(owner, repo, number);
  }));

  ipcMain.handle('github-create-pr', withContext('github-create-pr', async (_, { owner, repo, data }: { owner: string; repo: string; data: { title: string; body?: string; head: string; base: string; draft?: boolean } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.createPullRequest(owner, repo, data);
  }));

  ipcMain.handle('github-merge-pr', withContext('github-merge-pr', async (_, { owner, repo, number, options }: { owner: string; repo: string; number: number; options?: { commit_title?: string; commit_message?: string; merge_method?: 'merge' | 'squash' | 'rebase' } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.mergePullRequest(owner, repo, number, options);
  }));

  ipcMain.handle('github-close-pr', withContext('github-close-pr', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.closePullRequest(owner, repo, number);
  }));

  // CI/CD status operations
  ipcMain.handle('github-get-checks', withContext('github-get-checks', async (_, { owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.getCheckRuns(owner, repo, ref);
  }));

  ipcMain.handle('github-get-commit-status', withContext('github-get-commit-status', async (_, { owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.getCommitStatus(owner, repo, ref);
  }));

  ipcMain.handle('github-list-workflow-runs', withContext('github-list-workflow-runs', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { branch?: string; event?: string; status?: 'queued' | 'in_progress' | 'completed'; per_page?: number; page?: number } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.listWorkflowRuns(owner, repo, options);
  }));

  // Issue operations
  ipcMain.handle('github-list-issues', withContext('github-list-issues', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { state?: 'open' | 'closed' | 'all'; sort?: 'created' | 'updated' | 'comments'; direction?: 'asc' | 'desc'; labels?: string; per_page?: number; page?: number } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.listIssues(owner, repo, options);
  }));

  ipcMain.handle('github-get-issue', withContext('github-get-issue', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.getIssue(owner, repo, number);
  }));

  ipcMain.handle('github-create-issue', withContext('github-create-issue', async (_, { owner, repo, data }: { owner: string; repo: string; data: { title: string; body?: string; assignees?: string[]; labels?: string[] } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.createIssue(owner, repo, data);
  }));

  ipcMain.handle('github-close-issue', withContext('github-close-issue', async (_, { owner, repo, number }: { owner: string; repo: string; number: number }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.closeIssue(owner, repo, number);
  }));

  // Organization operations
  ipcMain.handle('github-list-orgs', withContext('github-list-orgs', async () => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.listOrganizations();
  }));

  // Branch operations
  ipcMain.handle('github-list-branches', withContext('github-list-branches', async (_, { owner, repo, options }: { owner: string; repo: string; options?: { protected_only?: boolean; per_page?: number; page?: number } }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.listBranches(owner, repo, options);
  }));

  // Utility operations
  ipcMain.handle('github-parse-remote', withContext('github-parse-remote', async (_, { remoteUrl }: { remoteUrl: string }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.parseGitHubRemote(remoteUrl);
  }));

  ipcMain.handle('github-is-github-remote', withContext('github-is-github-remote', async (_, { remoteUrl }: { remoteUrl: string }) => {
    const githubApi = await import('../services/githubApi.js');
    return githubApi.isGitHubRemote(remoteUrl);
  }));

  // ============================================================================
  // HOOKS HANDLERS
  // ============================================================================

  ipcMain.handle('get-hooks', withContext('get-hooks', async () => {
    return primitives.getAllHooks();
  }));

  ipcMain.handle('get-hook', withContext('get-hook', async (_, id: number) => {
    return primitives.getHook(id);
  }));

  ipcMain.handle('create-hook', withContext('create-hook', async (_, hook: Omit<primitives.HookConfig, 'id' | 'executionCount' | 'lastExecuted' | 'lastResult' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createHook(hook);
  }));

  ipcMain.handle('update-hook', withContext('update-hook', async (_, { id, updates }: { id: number; updates: Partial<primitives.HookConfig> }) => {
    primitives.updateHook(id, updates);
    return true;
  }));

  ipcMain.handle('delete-hook', withContext('delete-hook', async (_, id: number) => {
    primitives.deleteHook(id);
    return true;
  }));

  ipcMain.handle('get-hooks-by-event', withContext('get-hooks-by-event', async (_, { eventType, projectPath }: { eventType: primitives.HookEventType; projectPath?: string }) => {
    return primitives.getHooksByEventType(eventType, projectPath);
  }));

  // ============================================================================
  // HOOK EVENTS HANDLERS (Real-time hook event streaming)
  // ============================================================================

  // Hook server status
  ipcMain.handle('hook-server-status', withContext('hook-server-status', async () => {
    return getHookServerStatus();
  }));

  ipcMain.handle('hook-server-start', withContext('hook-server-start', async () => {
    await startHookServer();
    return getHookServerStatus();
  }));

  ipcMain.handle('hook-server-stop', withContext('hook-server-stop', async () => {
    await stopHookServer();
    return getHookServerStatus();
  }));

  // Hook scripts management
  ipcMain.handle('hook-scripts-status', withContext('hook-scripts-status', async () => {
    const installed = await areHookScriptsInstalled();
    const scripts = await getInstalledHookScripts();
    const validation = await validateAllHookScripts();
    return {
      installed,
      scriptsCount: scripts.length,
      scriptsPath: HOOKS_DIR,
      validation,
    };
  }));

  ipcMain.handle('hook-scripts-install', withContext('hook-scripts-install', async () => {
    await installAllHookScripts();
    return { success: true, scriptsPath: HOOKS_DIR };
  }));

  ipcMain.handle('hook-scripts-validate', withContext('hook-scripts-validate', async () => {
    return validateAllHookScripts();
  }));

  ipcMain.handle('hook-claude-config', withContext('hook-claude-config', async () => {
    return generateClaudeHooksConfig();
  }));

  // Hook event queries
  ipcMain.handle('get-hook-events', withContext('get-hook-events', async (_, { limit }: { limit?: number }) => {
    return hookEvents.getRecentHookEvents(limit);
  }));

  ipcMain.handle('get-hook-events-by-session', withContext('get-hook-events-by-session', async (_, { sessionId, limit }: { sessionId: string; limit?: number }) => {
    return hookEvents.getHookEventsBySession(sessionId, limit);
  }));

  ipcMain.handle('get-hook-events-by-type', withContext('get-hook-events-by-type', async (_, { eventType, limit }: { eventType: hookEvents.ExtendedHookEventType; limit?: number }) => {
    return hookEvents.getHookEventsByType(eventType, limit);
  }));

  ipcMain.handle('get-hook-event-stats', withContext('get-hook-event-stats', async () => {
    return hookEvents.getHookEventStats();
  }));

  ipcMain.handle('cleanup-hook-events', withContext('cleanup-hook-events', async (_, { maxAgeHours }: { maxAgeHours?: number }) => {
    return hookEvents.cleanupOldHookEvents(maxAgeHours);
  }));

  // Budget management
  ipcMain.handle('get-budgets', withContext('get-budgets', async () => {
    return hookEvents.getAllBudgets();
  }));

  ipcMain.handle('get-budget', withContext('get-budget', async (_, { projectPath, sessionId }: { projectPath?: string; sessionId?: string }) => {
    return hookEvents.getBudgetForScope(projectPath, sessionId);
  }));

  ipcMain.handle('upsert-budget', withContext('upsert-budget', async (_, budget: Omit<hookEvents.BudgetRecord, 'id' | 'createdAt' | 'updatedAt'>) => {
    return hookEvents.upsertBudget(budget);
  }));

  ipcMain.handle('update-budget-spent', withContext('update-budget-spent', async (_, { id, additionalCost }: { id: number; additionalCost: number }) => {
    hookEvents.updateBudgetSpent(id, additionalCost);
    return true;
  }));

  // Approval policies
  ipcMain.handle('get-approval-policies', withContext('get-approval-policies', async () => {
    return hookEvents.getAllApprovalPolicies();
  }));

  ipcMain.handle('get-enabled-approval-policies', withContext('get-enabled-approval-policies', async () => {
    return hookEvents.getEnabledApprovalPolicies();
  }));

  ipcMain.handle('create-approval-policy', withContext('create-approval-policy', async (_, policy: Omit<hookEvents.ApprovalPolicy, 'id' | 'createdAt' | 'updatedAt'>) => {
    return hookEvents.createApprovalPolicy(policy);
  }));

  ipcMain.handle('update-approval-policy', withContext('update-approval-policy', async (_, { id, updates }: { id: number; updates: Partial<hookEvents.ApprovalPolicy> }) => {
    hookEvents.updateApprovalPolicy(id, updates);
    return true;
  }));

  ipcMain.handle('delete-approval-policy', withContext('delete-approval-policy', async (_, id: number) => {
    hookEvents.deleteApprovalPolicy(id);
    return true;
  }));

  // ============================================================================
  // MCP SERVER HANDLERS
  // ============================================================================

  ipcMain.handle('get-mcp-servers', withContext('get-mcp-servers', async () => {
    return primitives.getAllMCPServers();
  }));

  ipcMain.handle('get-mcp-server', withContext('get-mcp-server', async (_, id: number) => {
    return primitives.getMCPServer(id);
  }));

  ipcMain.handle('create-mcp-server', withContext('create-mcp-server', async (_, server: Omit<primitives.MCPServer, 'id' | 'status' | 'lastConnected' | 'errorMessage' | 'toolCount' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createMCPServer(server);
  }));

  ipcMain.handle('update-mcp-server', withContext('update-mcp-server', async (_, { id, updates }: { id: number; updates: Partial<primitives.MCPServer> }) => {
    primitives.updateMCPServer(id, updates);
    return true;
  }));

  ipcMain.handle('delete-mcp-server', withContext('delete-mcp-server', async (_, id: number) => {
    primitives.deleteMCPServer(id);
    return true;
  }));

  ipcMain.handle('set-mcp-server-status', withContext('set-mcp-server-status', async (_, { id, status, errorMessage }: { id: number; status: primitives.MCPServer['status']; errorMessage?: string }) => {
    primitives.updateMCPServerStatus(id, status, errorMessage);
    return true;
  }));

  // ============================================================================
  // AGENT TEMPLATE HANDLERS
  // ============================================================================

  ipcMain.handle('get-agent-templates', withContext('get-agent-templates', async () => {
    return primitives.getAllAgentTemplates();
  }));

  ipcMain.handle('get-agent-template', withContext('get-agent-template', async (_, id: string) => {
    return primitives.getAgentTemplate(id);
  }));

  ipcMain.handle('create-agent-template', withContext('create-agent-template', async (_, template: Omit<primitives.AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
    // Generate a unique ID for the agent template
    const id = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return primitives.createAgentTemplate({ ...template, id });
  }));

  ipcMain.handle('update-agent-template', withContext('update-agent-template', async (_, { id, updates }: { id: string; updates: Partial<primitives.AgentTemplate> }) => {
    primitives.updateAgentTemplate(id, updates);
    return true;
  }));

  ipcMain.handle('delete-agent-template', withContext('delete-agent-template', async (_, id: string) => {
    primitives.deleteAgentTemplate(id);
    return true;
  }));

  // ============================================================================
  // PROJECT CONFIG HANDLERS
  // ============================================================================

  ipcMain.handle('get-project-configs', withContext('get-project-configs', async () => {
    return primitives.getAllProjectConfigs();
  }));

  ipcMain.handle('get-project-config', withContext('get-project-config', async (_, projectPath: string) => {
    return primitives.getProjectConfig(projectPath);
  }));

  ipcMain.handle('get-project-config-by-path', withContext('get-project-config-by-path', async (_, projectPath: string) => {
    return primitives.getProjectConfig(projectPath);
  }));

  ipcMain.handle('create-project-config', withContext('create-project-config', async (_, config: Omit<primitives.ProjectConfig, 'createdAt' | 'updatedAt'>) => {
    return primitives.createProjectConfig(config);
  }));

  ipcMain.handle('update-project-config', withContext('update-project-config', async (_, { projectPath, updates }: { projectPath: string; updates: Partial<primitives.ProjectConfig> }) => {
    primitives.updateProjectConfig(projectPath, updates);
    return true;
  }));

  ipcMain.handle('delete-project-config', withContext('delete-project-config', async (_, projectPath: string) => {
    primitives.deleteProjectConfig(projectPath);
    return true;
  }));

  // ============================================================================
  // AGENT REGISTRY HANDLERS
  // ============================================================================

  ipcMain.handle('get-agent-registry-entries', withContext('get-agent-registry-entries', async () => {
    const agents = primitives.getAllAgents();
    logger.info('[DEBUG] get-agent-registry-entries called, returning:', {
      count: agents.length,
      agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status })),
    });
    return agents;
  }));

  ipcMain.handle('get-agent-registry-entry', withContext('get-agent-registry-entry', async (_, id: string) => {
    return primitives.getAgent(id);
  }));

  ipcMain.handle('get-active-agents', withContext('get-active-agents', async () => {
    return primitives.getActiveAgents();
  }));

  ipcMain.handle('get-agent-children', withContext('get-agent-children', async (_, parentId: string) => {
    return primitives.getAgentsByParent(parentId);
  }));

  ipcMain.handle('create-agent-registry-entry', withContext('create-agent-registry-entry', async (_, entry: Omit<primitives.AgentRecord, 'spawnedAt' | 'lastActivity' | 'completedAt' | 'exitCode' | 'errorMessage'>) => {
    return primitives.registerAgent(entry);
  }));

  ipcMain.handle('update-agent-registry-entry', withContext('update-agent-registry-entry', async (_, { id, updates }: { id: string; updates: { status?: primitives.AgentStatus; errorMessage?: string } }) => {
    if (updates.status) {
      primitives.updateAgentStatus(id, updates.status, updates.errorMessage);
    }
    return true;
  }));

  ipcMain.handle('delete-agent-registry-entry', withContext('delete-agent-registry-entry', async (_, id: string) => {
    primitives.deleteAgent(id);
    return true;
  }));

  // ============================================================================
  // SKILLS HANDLERS
  // ============================================================================

  ipcMain.handle('get-skills', withContext('get-skills', async () => {
    return primitives.getAllSkills();
  }));

  ipcMain.handle('get-skill', withContext('get-skill', async (_, id: number) => {
    return primitives.getSkill(id);
  }));

  ipcMain.handle('create-skill', withContext('create-skill', async (_, skill: Omit<primitives.Skill, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createSkill(skill);
  }));

  ipcMain.handle('update-skill', withContext('update-skill', async (_, { id, updates }: { id: number; updates: Partial<primitives.Skill> }) => {
    primitives.updateSkill(id, updates);
    return true;
  }));

  ipcMain.handle('delete-skill', withContext('delete-skill', async (_, id: number) => {
    primitives.deleteSkill(id);
    return true;
  }));

  ipcMain.handle('increment-skill-usage', withContext('increment-skill-usage', async (_, id: number) => {
    primitives.recordSkillUsage(id);
    return true;
  }));

  // ============================================================================
  // TASK DEFINITION HANDLERS
  // ============================================================================

  ipcMain.handle('get-task-definitions', withContext('get-task-definitions', async () => {
    return primitives.getAllTaskDefinitions();
  }));

  ipcMain.handle('get-task-definition', withContext('get-task-definition', async (_, id: number) => {
    return primitives.getTaskDefinition(id);
  }));

  ipcMain.handle('create-task-definition', withContext('create-task-definition', async (_, task: Omit<primitives.TaskDefinition, 'id' | 'lastRun' | 'lastResult' | 'runCount' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createTaskDefinition(task);
  }));

  ipcMain.handle('update-task-definition', withContext('update-task-definition', async (_, { id, updates }: { id: number; updates: Partial<primitives.TaskDefinition> }) => {
    primitives.updateTaskDefinition(id, updates);
    return true;
  }));

  ipcMain.handle('delete-task-definition', withContext('delete-task-definition', async (_, id: number) => {
    primitives.deleteTaskDefinition(id);
    return true;
  }));

  // ============================================================================
  // SESSION ANALYTICS HANDLERS
  // ============================================================================

  ipcMain.handle('get-session-analytics', withContext('get-session-analytics', async (_, sessionId: string) => {
    return primitives.getSessionAnalytics(sessionId);
  }));

  ipcMain.handle('create-session-analytics', withContext('create-session-analytics', async (_, analytics: Partial<primitives.SessionAnalytics> & { sessionId: string }) => {
    primitives.upsertSessionAnalytics(analytics);
    return true;
  }));

  ipcMain.handle('update-session-analytics', withContext('update-session-analytics', async (_, { sessionId, updates }: { sessionId: string; updates: Partial<primitives.SessionAnalytics> }) => {
    primitives.upsertSessionAnalytics({ sessionId, ...updates });
    return true;
  }));

  // ============================================================================
  // TOOL USAGE DETAILED HANDLERS
  // ============================================================================

  ipcMain.handle('get-tool-usage-detailed', withContext('get-tool-usage-detailed', async (_, sessionId: string) => {
    return primitives.getDetailedToolUsageBySession(sessionId);
  }));

  ipcMain.handle('record-tool-usage', withContext('record-tool-usage', async (_, usage: Omit<primitives.DetailedToolUsage, 'id' | 'timestamp'>) => {
    primitives.recordDetailedToolUsage(usage);
    return true;
  }));

  ipcMain.handle('get-tool-usage-summary', withContext('get-tool-usage-summary', async () => {
    return primitives.getToolEfficiencyStats();
  }));

  // ============================================================================
  // CLIPBOARD HANDLERS
  // ============================================================================

  ipcMain.handle('clipboard-read', withContext('clipboard-read', async () => {
    return clipboard.readText();
  }));

  ipcMain.handle('clipboard-write', withContext('clipboard-write', async (_, text: string) => {
    clipboard.writeText(text);
    return true;
  }));

  // ============================================================================
  // CONTEXT MENU HANDLERS
  // ============================================================================

  ipcMain.handle('show-context-menu', withContext('show-context-menu', async (event, options: {
    hasSelection: boolean;
    isEditable: boolean;
    isTerminal?: boolean;
  }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

    // Cut - only for editable fields with selection
    if (options.isEditable && options.hasSelection) {
      menuTemplate.push({
        label: 'Cut',
        accelerator: 'CmdOrCtrl+X',
        role: 'cut',
      });
    }

    // Copy - for any selection
    if (options.hasSelection) {
      menuTemplate.push({
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        role: 'copy',
      });
    }

    // Paste - for editable fields or terminal
    if (options.isEditable || options.isTerminal) {
      menuTemplate.push({
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        role: 'paste',
      });
    }

    // Select All - for editable fields
    if (options.isEditable) {
      if (menuTemplate.length > 0) {
        menuTemplate.push({ type: 'separator' });
      }
      menuTemplate.push({
        label: 'Select All',
        accelerator: 'CmdOrCtrl+A',
        role: 'selectAll',
      });
    }

    // Only show menu if there are items
    if (menuTemplate.length > 0) {
      const menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup({ window });
    }
  }));

  // Terminal-specific context menu with clipboard access via IPC
  ipcMain.handle('show-terminal-context-menu', withContext('show-terminal-context-menu', async (event, options: {
    hasSelection: boolean;
    selectedText?: string;
  }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return null;

    return new Promise<string | null>((resolve) => {
      const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

      if (options.hasSelection && options.selectedText) {
        menuTemplate.push({
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => {
            clipboard.writeText(options.selectedText!);
            resolve('copy');
          },
        });
      }

      const clipboardText = clipboard.readText();
      if (clipboardText) {
        menuTemplate.push({
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          click: () => {
            resolve('paste');
          },
        });
      }

      if (menuTemplate.length > 0) {
        menuTemplate.push({ type: 'separator' });
      }

      menuTemplate.push({
        label: 'Clear Terminal',
        click: () => {
          resolve('clear');
        },
      });

      const menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup({
        window,
        callback: () => {
          // Menu closed without selection
          resolve(null);
        },
      });
    });
  }));

  // ============================================================================
  // AGENCY INDEX HANDLERS (Agent & Skill Browser)
  // ============================================================================

  // Agency Index initialization and status
  ipcMain.handle('agency-index-status', withContext('agency-index-status', async () => {
    return agencyIndex.getIndexStats();
  }));

  ipcMain.handle('agency-index-init', withContext('agency-index-init', async (_, config: { agencyPath: string }) => {
    try {
      // Create tables
      agencyIndex.createAgencyIndexTables();

      // Initialize indexers
      initializeAgentIndexer({
        agencyPath: config.agencyPath,
        agentSubpath: '.claude/agents/webdev',
      });

      initializeSkillIndexer({
        agencyPath: config.agencyPath,
        skillSubpath: '.claude/skills/webdev',
      });

      // Initialize context injection service
      initializeContextInjectionService();

      return { success: true };
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to initialize agency index: ${error.message}`);
      return { success: false, error: error.message };
    }
  }));

  // Agent indexer operations
  ipcMain.handle('agency-index-agents', withContext('agency-index-agents', async () => {
    try {
      const indexer = getAgentIndexer();
      return await indexer.indexAll();
    } catch (err) {
      const error = err as Error;
      return { success: false, count: 0, errors: [error.message] };
    }
  }));

  ipcMain.handle('agency-agent-indexer-status', withContext('agency-agent-indexer-status', async () => {
    try {
      const indexer = getAgentIndexer();
      return indexer.getStatus();
    } catch (err) {
      return { indexing: false, lastIndexTime: null, agentCount: 0 };
    }
  }));

  // Skill indexer operations
  ipcMain.handle('agency-index-skills', withContext('agency-index-skills', async () => {
    try {
      const indexer = getSkillIndexer();
      return await indexer.indexAll();
    } catch (err) {
      const error = err as Error;
      return { success: false, count: 0, errors: [error.message] };
    }
  }));

  ipcMain.handle('agency-skill-indexer-status', withContext('agency-skill-indexer-status', async () => {
    try {
      const indexer = getSkillIndexer();
      return indexer.getStatus();
    } catch (err) {
      return { indexing: false, lastIndexTime: null, skillCount: 0 };
    }
  }));

  // Category operations
  ipcMain.handle('agency-get-categories', withContext('agency-get-categories', async (_, type?: 'agent' | 'skill') => {
    return agencyIndex.getCategories(type);
  }));

  ipcMain.handle('agency-get-category-tree', withContext('agency-get-category-tree', async (_, type: 'agent' | 'skill') => {
    return agencyIndex.getCategoryTree(type);
  }));

  // Indexed agent operations
  ipcMain.handle('agency-get-indexed-agents', withContext('agency-get-indexed-agents', async () => {
    return agencyIndex.getAllIndexedAgents();
  }));

  ipcMain.handle('agency-get-indexed-agent', withContext('agency-get-indexed-agent', async (_, id: number) => {
    return agencyIndex.getIndexedAgent(id);
  }));

  ipcMain.handle('agency-get-indexed-agent-by-slug', withContext('agency-get-indexed-agent-by-slug', async (_, slug: string) => {
    return agencyIndex.getIndexedAgentBySlug(slug);
  }));

  ipcMain.handle('agency-get-agents-by-category', withContext('agency-get-agents-by-category', async (_, categoryPath: string) => {
    return agencyIndex.getIndexedAgentsByCategoryPath(categoryPath);
  }));

  ipcMain.handle('agency-get-popular-agents', withContext('agency-get-popular-agents', async (_, limit?: number) => {
    return agencyIndex.getPopularAgents(limit);
  }));

  ipcMain.handle('agency-get-recent-agents', withContext('agency-get-recent-agents', async (_, limit?: number) => {
    return agencyIndex.getRecentlyUsedAgents(limit);
  }));

  ipcMain.handle('agency-search-agents', withContext('agency-search-agents', async (_, { query, limit }: { query: string; limit?: number }) => {
    return agencyIndex.searchIndexedAgents(query, limit);
  }));

  // Indexed skill operations
  ipcMain.handle('agency-get-indexed-skills', withContext('agency-get-indexed-skills', async () => {
    return agencyIndex.getAllIndexedSkills();
  }));

  ipcMain.handle('agency-get-indexed-skill', withContext('agency-get-indexed-skill', async (_, id: number) => {
    return agencyIndex.getIndexedSkill(id);
  }));

  ipcMain.handle('agency-get-indexed-skill-by-slug', withContext('agency-get-indexed-skill-by-slug', async (_, slug: string) => {
    return agencyIndex.getIndexedSkillBySlug(slug);
  }));

  ipcMain.handle('agency-get-skills-by-category', withContext('agency-get-skills-by-category', async (_, categoryPath: string) => {
    return agencyIndex.getIndexedSkillsByCategoryPath(categoryPath);
  }));

  ipcMain.handle('agency-get-skills-by-agent', withContext('agency-get-skills-by-agent', async (_, agentSlug: string) => {
    return agencyIndex.getIndexedSkillsByAgent(agentSlug);
  }));

  ipcMain.handle('agency-get-popular-skills', withContext('agency-get-popular-skills', async (_, limit?: number) => {
    return agencyIndex.getPopularSkills(limit);
  }));

  ipcMain.handle('agency-get-recent-skills', withContext('agency-get-recent-skills', async (_, limit?: number) => {
    return agencyIndex.getRecentlyUsedSkills(limit);
  }));

  ipcMain.handle('agency-search-skills', withContext('agency-search-skills', async (_, { query, limit }: { query: string; limit?: number }) => {
    return agencyIndex.searchIndexedSkills(query, limit);
  }));

  // Active agent operations
  ipcMain.handle('agency-activate-agent', withContext('agency-activate-agent', async (_, { agentId, sessionId, projectPath, priority }: { agentId: number; sessionId?: string; projectPath?: string; priority?: number }) => {
    const service = getContextInjectionService();
    return service.activateAgentForSession(agentId, sessionId, projectPath, priority);
  }));

  ipcMain.handle('agency-deactivate-agent', withContext('agency-deactivate-agent', async (_, { agentId, sessionId, projectPath }: { agentId: number; sessionId?: string; projectPath?: string }) => {
    const service = getContextInjectionService();
    service.deactivateAgentForSession(agentId, sessionId, projectPath);
    return true;
  }));

  ipcMain.handle('agency-get-active-agents-for-session', withContext('agency-get-active-agents-for-session', async (_, sessionId: string) => {
    return agencyIndex.getActiveAgentsForSession(sessionId);
  }));

  ipcMain.handle('agency-get-active-agents-for-project', withContext('agency-get-active-agents-for-project', async (_, projectPath: string) => {
    return agencyIndex.getActiveAgentsForProject(projectPath);
  }));

  ipcMain.handle('agency-get-all-active-agents', withContext('agency-get-all-active-agents', async () => {
    return agencyIndex.getAllActiveAgentConfigs();
  }));

  // Skill queue operations
  ipcMain.handle('agency-queue-skill', withContext('agency-queue-skill', async (_, { skillId, sessionId, projectPath, priority }: { skillId: number; sessionId?: string; projectPath?: string; priority?: number }) => {
    const service = getContextInjectionService();
    return service.queueSkillForSession(skillId, sessionId, projectPath, priority);
  }));

  ipcMain.handle('agency-remove-queued-skill', withContext('agency-remove-queued-skill', async (_, id: number) => {
    const service = getContextInjectionService();
    service.removeSkillFromQueue(id);
    return true;
  }));

  ipcMain.handle('agency-get-pending-skills', withContext('agency-get-pending-skills', async () => {
    return agencyIndex.getAllPendingSkills();
  }));

  ipcMain.handle('agency-get-pending-skills-for-session', withContext('agency-get-pending-skills-for-session', async (_, sessionId: string) => {
    return agencyIndex.getPendingSkillsForSession(sessionId);
  }));

  ipcMain.handle('agency-clear-skill-queue', withContext('agency-clear-skill-queue', async (_, { sessionId, projectPath }: { sessionId?: string; projectPath?: string }) => {
    const service = getContextInjectionService();
    service.clearQueue(sessionId, projectPath);
    return true;
  }));

  // Context injection operations
  ipcMain.handle('agency-inject-context', withContext('agency-inject-context', async (_, context: { sessionId: string; projectPath: string; workingDirectory: string }) => {
    const service = getContextInjectionService();
    return service.injectForSession(context);
  }));

  ipcMain.handle('agency-read-claude-md', withContext('agency-read-claude-md', async (_, workingDirectory: string) => {
    const service = getContextInjectionService();
    return service.readClaudeMd(workingDirectory);
  }));

  ipcMain.handle('agency-clear-injected-sections', withContext('agency-clear-injected-sections', async (_, workingDirectory: string) => {
    const service = getContextInjectionService();
    return service.clearInjectedSections(workingDirectory);
  }));

  ipcMain.handle('agency-get-section-markers', withContext('agency-get-section-markers', async () => {
    const service = getContextInjectionService();
    return service.getSectionMarkers();
  }));

  // Usage tracking
  ipcMain.handle('agency-record-agent-usage', withContext('agency-record-agent-usage', async (_, id: number) => {
    agencyIndex.recordAgentUsage(id);
    return true;
  }));

  ipcMain.handle('agency-record-skill-usage', withContext('agency-record-skill-usage', async (_, id: number) => {
    agencyIndex.recordSkillUsage(id);
    return true;
  }));

  // ============================================================================
  // PHASE 5-12 HANDLERS
  // ============================================================================

  // Initialize project registry and coordinator services
  initProjectRegistry();
  initProjectCoordinator();

  // Register phase-specific handlers
  registerPhase5to8Handlers();
  registerPhase9to12Handlers();

  logger.info('IPC handlers registered');
}

// ============================================================================
// EXPORT FORMATTERS
// ============================================================================

function formatAsMarkdown(session: any, messages: any[]): string {
  let md = `# Session: ${session.customTitle || session.projectName || session.id}\n\n`;
  md += `**Project:** ${session.projectName}\n`;
  md += `**Date:** ${session.startTime}\n`;
  md += `**Messages:** ${session.messageCount}\n`;
  md += `**Tokens:** ${session.tokenCount}\n`;
  md += `**Cost:** $${(session.cost ?? 0).toFixed(2)}\n\n`;
  md += `---\n\n`;

  for (const msg of messages) {
    md += `## ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}\n\n`;
    md += `${msg.content}\n\n`;
  }

  return md;
}

function formatAsHtml(session: any, messages: any[]): string {
  let html = `<!DOCTYPE html>
<html>
<head>
  <title>Session: ${session.customTitle || session.id}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; }
    .meta { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .message { margin: 20px 0; padding: 15px; border-radius: 8px; }
    .user { background: #e3f2fd; }
    .assistant { background: #f3e5f5; }
    .thinking { background: #fff3e0; font-style: italic; }
    .tool { background: #e8f5e9; font-family: monospace; }
    pre { overflow-x: auto; }
  </style>
</head>
<body>
  <h1>${session.customTitle || session.projectName || session.id}</h1>
  <div class="meta">
    <p><strong>Project:</strong> ${session.projectName}</p>
    <p><strong>Date:</strong> ${session.startTime}</p>
    <p><strong>Messages:</strong> ${session.messageCount}</p>
    <p><strong>Tokens:</strong> ${session.tokenCount}</p>
    <p><strong>Cost:</strong> $${(session.cost ?? 0).toFixed(2)}</p>
  </div>`;

  for (const msg of messages) {
    html += `<div class="message ${msg.role}">
      <strong>${msg.role}</strong>
      <pre>${escapeHtml(msg.content)}</pre>
    </div>`;
  }

  html += `</body></html>`;
  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
