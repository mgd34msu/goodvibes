// ============================================================================
// TAG SUGGESTIONS IPC HANDLERS - Handle AI suggestion IPC requests
// ============================================================================

import { ipcMain } from 'electron';
import { z } from 'zod';
import { Logger } from '../../services/logger.js';
import tagSuggestionService from '../../services/tagSuggestionService.js';
import { withContext } from '../utils.js';
import * as db from '../../database/tagSuggestions.js';
import * as tags from '../../database/tags.js';
import { ipcOk, ipcErr } from '../../../shared/types/ipc-types.js';

const logger = new Logger('IPC:TagSuggestions');

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const sessionIdSchema = z.string().min(1);
const suggestionIdSchema = z.number().int().positive();
const daysSchema = z.number().int().positive();
const limitSchema = z.number().int().positive().optional();
const tagNameSchema = z.string().min(1);
const contextHashSchema = z.string().nullable();
const suggestionStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'dismissed']);
const scanStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed', 'skipped']);
const scanDepthSchema = z.enum(['quick', 'full']).optional();

// ============================================================================
// HANDLER REGISTRATION
// ============================================================================

/**
 * Registers all tag suggestion-related IPC handlers.
 * Handles AI tag suggestion management, feedback tracking, and scan status.
 */
export function registerTagSuggestionHandlers(): void {
  // ============================================================================
  // SUGGESTION MANAGEMENT
  // ============================================================================

  ipcMain.handle('get-session-suggestions', withContext('get-session-suggestions', async (_, sessionId: unknown) => {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) {
      return ipcErr(`Invalid session ID: ${parsed.error.message}`, []);
    }
    try {
      const suggestions = db.getSessionSuggestions(parsed.data);
      return ipcOk(suggestions);
    } catch (error) {
      logger.error('Failed to get session suggestions', error, { sessionId: parsed.data });
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('get-suggestion', withContext('get-suggestion', async (_, id: unknown) => {
    const parsed = suggestionIdSchema.safeParse(id);
    if (!parsed.success) {
      return ipcErr(`Invalid suggestion ID: ${parsed.error.message}`, null);
    }
    try {
      const suggestion = db.getSuggestion(parsed.data);
      return ipcOk(suggestion);
    } catch (error) {
      logger.error('Failed to get suggestion', error, { id: parsed.data });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('accept-suggestion', withContext('accept-suggestion', async (_, id: unknown) => {
    const parsed = suggestionIdSchema.safeParse(id);
    if (!parsed.success) {
      return ipcErr(`Invalid suggestion ID: ${parsed.error.message}`, null);
    }
    try {
      // Get the suggestion first
      const suggestion = db.getSuggestion(parsed.data);
      if (!suggestion) {
        return ipcErr('Suggestion not found', null);
      }

      // Accept the suggestion (this also creates tag and applies to session)
      db.acceptSuggestion(parsed.data);

      // Get the tag that was created/used
      const tag = tags.getTagByName(suggestion.tagName);

      return ipcOk({ suggestion, tag });
    } catch (error) {
      logger.error('Failed to accept suggestion', error, { id: parsed.data });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('reject-suggestion', withContext('reject-suggestion', async (_, id: unknown) => {
    const parsed = suggestionIdSchema.safeParse(id);
    if (!parsed.success) {
      return ipcErr(`Invalid suggestion ID: ${parsed.error.message}`, false);
    }
    try {
      db.rejectSuggestion(parsed.data);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to reject suggestion', error, { id: parsed.data });
      return ipcErr(error, false);
    }
  }));

  ipcMain.handle('dismiss-suggestion', withContext('dismiss-suggestion', async (_, id: unknown) => {
    const parsed = suggestionIdSchema.safeParse(id);
    if (!parsed.success) {
      return ipcErr(`Invalid suggestion ID: ${parsed.error.message}`, false);
    }
    try {
      db.dismissSuggestion(parsed.data);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to dismiss suggestion', error, { id: parsed.data });
      return ipcErr(error, false);
    }
  }));

  ipcMain.handle('accept-all-suggestions', withContext('accept-all-suggestions', async (_, sessionId: unknown) => {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) {
      return ipcErr(`Invalid session ID: ${parsed.error.message}`, 0);
    }
    try {
      const count = db.acceptAllSuggestions(parsed.data);
      return ipcOk(count);
    } catch (error) {
      logger.error('Failed to accept all suggestions', error, { sessionId: parsed.data });
      return ipcErr(error, 0);
    }
  }));

  ipcMain.handle('dismiss-all-suggestions', withContext('dismiss-all-suggestions', async (_, sessionId: unknown) => {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) {
      return ipcErr(`Invalid session ID: ${parsed.error.message}`, 0);
    }
    try {
      const count = db.dismissAllSuggestions(parsed.data);
      return ipcOk(count);
    } catch (error) {
      logger.error('Failed to dismiss all suggestions', error, { sessionId: parsed.data });
      return ipcErr(error, 0);
    }
  }));

  ipcMain.handle('delete-old-suggestions', withContext('delete-old-suggestions', async (_, days: unknown) => {
    const parsed = daysSchema.safeParse(days);
    if (!parsed.success) {
      return ipcErr(`Invalid days value: ${parsed.error.message}`, 0);
    }
    try {
      const count = db.deleteOldSuggestions(parsed.data);
      return ipcOk(count);
    } catch (error) {
      logger.error('Failed to delete old suggestions', error, { days: parsed.data });
      return ipcErr(error, 0);
    }
  }));

  // ============================================================================
  // FEEDBACK
  // ============================================================================

  ipcMain.handle('record-suggestion-feedback', withContext('record-suggestion-feedback', async (_, params: unknown) => {
    const paramsSchema = z.object({
      tagName: tagNameSchema,
      contextHash: contextHashSchema,
      accepted: z.boolean(),
    });
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      return ipcErr(`Invalid parameters: ${parsed.error.message}`, false);
    }
    try {
      db.recordSuggestionFeedback(parsed.data.tagName, parsed.data.contextHash, parsed.data.accepted);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to record suggestion feedback', error, parsed.data);
      return ipcErr(error, false);
    }
  }));

  ipcMain.handle('get-suggestion-feedback', withContext('get-suggestion-feedback', async (_, params: unknown) => {
    const paramsSchema = z.object({
      tagName: tagNameSchema,
      contextHash: contextHashSchema,
    });
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      return ipcErr(`Invalid parameters: ${parsed.error.message}`, null);
    }
    try {
      const feedback = db.getSuggestionFeedback(parsed.data.tagName, parsed.data.contextHash);
      return ipcOk(feedback);
    } catch (error) {
      logger.error('Failed to get suggestion feedback', error, parsed.data);
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('is-tag-frequently-rejected', withContext('is-tag-frequently-rejected', async (_, params: unknown) => {
    const paramsSchema = z.object({
      tagName: tagNameSchema,
      contextHash: contextHashSchema,
      threshold: z.number().min(0).max(1).optional(),
    });
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      return ipcErr(`Invalid parameters: ${parsed.error.message}`, false);
    }
    try {
      const isRejected = db.isTagFrequentlyRejected(
        parsed.data.tagName,
        parsed.data.contextHash,
        parsed.data.threshold
      );
      return ipcOk(isRejected);
    } catch (error) {
      logger.error('Failed to check tag rejection status', error, parsed.data);
      return ipcErr(error, false);
    }
  }));

  // ============================================================================
  // SCAN MANAGEMENT
  // ============================================================================

  ipcMain.handle('update-session-scan-status', withContext('update-session-scan-status', async (_, params: unknown) => {
    const paramsSchema = z.object({
      sessionId: sessionIdSchema,
      status: scanStatusSchema,
      depth: scanDepthSchema,
    });
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      return ipcErr(`Invalid parameters: ${parsed.error.message}`, false);
    }
    try {
      db.updateSessionScanStatus(
        parsed.data.sessionId,
        parsed.data.status as unknown as import('../../../shared/types/index.js').ScanStatus,
        parsed.data.depth
      );
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to update session scan status', error, parsed.data);
      return ipcErr(error, false);
    }
  }));

  ipcMain.handle('get-pending-sessions', withContext('get-pending-sessions', async (_, limit: unknown) => {
    const parsed = limitSchema.safeParse(limit);
    if (!parsed.success && limit !== undefined) {
      return ipcErr(`Invalid limit: ${parsed.error?.message ?? 'unknown error'}`, []);
    }
    try {
      const sessions = db.getPendingSessions(parsed.data);
      return ipcOk(sessions);
    } catch (error) {
      logger.error('Failed to get pending sessions', error, { limit: parsed.data });
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('get-sessions-needing-rescan', withContext('get-sessions-needing-rescan', async () => {
    try {
      const sessions = db.getSessionsNeedingRescan();
      return ipcOk(sessions);
    } catch (error) {
      logger.error('Failed to get sessions needing rescan', error);
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('get-scan-counts', withContext('get-scan-counts', async () => {
    try {
      const counts = db.getScanCounts();
      return ipcOk(counts);
    } catch (error) {
      logger.error('Failed to get scan counts', error);
      return ipcErr(error, { scanned: 0, pending: 0, total: 0 });
    }
  }));

  ipcMain.handle('get-session-scan-status', withContext('get-session-scan-status', async (_, sessionId: unknown) => {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) {
      return ipcErr(`Invalid session ID: ${parsed.error.message}`, null);
    }
    try {
      const status = db.getSessionScanStatus(parsed.data);
      return ipcOk(status);
    } catch (error) {
      logger.error('Failed to get session scan status', error, { sessionId: parsed.data });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('skip-old-sessions', withContext('skip-old-sessions', async (_, days: unknown) => {
    const parsed = daysSchema.safeParse(days);
    if (!parsed.success) {
      return ipcErr(`Invalid days value: ${parsed.error.message}`, 0);
    }
    try {
      const count = db.skipOldSessions(parsed.data);
      return ipcOk(count);
    } catch (error) {
      logger.error('Failed to skip old sessions', error, { days: parsed.data });
      return ipcErr(error, 0);
    }
  }));

  // ============================================================================
  // SCAN CONTROL (Phase 5 AI service integration)
  // ============================================================================

  ipcMain.handle('start-background-scan', withContext('start-background-scan', async () => {
    try {
      await tagSuggestionService.scanAll();
      logger.info('Background scan started');
      return ipcOk(undefined);
    } catch (error) {
      logger.error('Failed to start background scan', error);
      return ipcErr(error);
    }
  }));

  ipcMain.handle('stop-background-scan', withContext('stop-background-scan', async () => {
    try {
      tagSuggestionService.stop();
      logger.info('Background scan stopped');
      return ipcOk(undefined);
    } catch (error) {
      logger.error('Failed to stop background scan', error);
      return ipcErr(error);
    }
  }));

  ipcMain.handle('get-scan-progress', withContext('get-scan-progress', async () => {
    try {
      const progress = tagSuggestionService.getProgress();
      return ipcOk(progress);
    } catch (error) {
      logger.error('Failed to get scan progress', error);
      return ipcErr(error, {
        current: 0,
        total: 0,
        percentage: 0,
        estimatedTimeMs: 0,
      });
    }
  }));

  ipcMain.handle('estimate-scan-cost', withContext('estimate-scan-cost', async () => {
    try {
      const counts = db.getScanCounts();
      // Note: Cost estimation removed since we're using Claude CLI (no API cost)
      // Return estimated time only based on pending sessions
      const estimatedTimeMinutes = Math.ceil(counts.pending / 60); // Rough estimate
      return ipcOk({
        totalSessions: counts.pending,
        estimatedTokens: 0,
        estimatedCost: 0, // No cost with CLI
        estimatedTimeMinutes,
      });
    } catch (error) {
      logger.error('Failed to estimate scan cost', error);
      return ipcErr(error, {
        totalSessions: 0,
        estimatedTokens: 0,
        estimatedCost: 0,
        estimatedTimeMinutes: 0,
      });
    }
  }));

  logger.info('Tag suggestion handlers registered');
}
