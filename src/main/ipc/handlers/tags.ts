// ============================================================================
// TAG IPC HANDLERS - Handle tag-related IPC requests from renderer
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as db from '../../database/index.js';
import { ipcOk, ipcErr } from '../../../shared/types/index.js';
import {
  createTagSchema,
  updateTagSchema,
  mergeTagsSchema,
  tagEffectSchema,
} from '../schemas/tags.js';

const logger = new Logger('IPC:Tags');

/**
 * Registers all tag-related IPC handlers.
 * Handles tag CRUD operations, session-tag associations, and tag properties.
 */
export function registerTagHandlers(): void {
  // ============================================================================
  // TAG CRUD OPERATIONS
  // ============================================================================

  ipcMain.handle('get-all-tags', withContext('get-all-tags', async () => {
    try {
      const tags = db.getAllTags();
      return ipcOk(tags);
    } catch (error) {
      logger.error('Failed to get all tags', { error });
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('get-tag', withContext('get-tag', async (_, id: unknown) => {
    try {
      if (typeof id !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      const tag = db.getTag(id);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to get tag', { error, id });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('get-tag-by-name', withContext('get-tag-by-name', async (_, name: unknown) => {
    try {
      if (typeof name !== 'string') {
        return ipcErr('Invalid tag name: must be a string', null);
      }
      const tag = db.getTagByName(name);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to get tag by name', { error, name });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('create-tag', withContext('create-tag', async (_, input: unknown) => {
    try {
      const parsed = createTagSchema.safeParse(input);
      if (!parsed.success) {
        const errorMsg = `Invalid input: ${parsed.error.errors.map(e => e.message).join(', ')}`;
        logger.warn('create-tag: Validation failed', { input, errors: parsed.error.errors });
        return ipcErr(errorMsg, null);
      }
      // Convert null to undefined for parentId and description
      const dbInput = {
        ...parsed.data,
        parentId: parsed.data.parentId ?? undefined,
        description: parsed.data.description ?? undefined,
      };
      const tag = db.createTag(dbInput);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to create tag', { error, input });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('update-tag', withContext('update-tag', async (_, id: unknown, input: unknown) => {
    try {
      if (typeof id !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      const parsed = updateTagSchema.safeParse(input);
      if (!parsed.success) {
        const errorMsg = `Invalid input: ${parsed.error.errors.map(e => e.message).join(', ')}`;
        logger.warn('update-tag: Validation failed', { id, input, errors: parsed.error.errors });
        return ipcErr(errorMsg, null);
      }
      const tag = db.updateTag(id, parsed.data);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to update tag', { error, id, input });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('delete-tag', withContext('delete-tag', async (_, id: unknown, reassignTo?: unknown) => {
    try {
      if (typeof id !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      if (reassignTo !== undefined && typeof reassignTo !== 'number') {
        return ipcErr('Invalid reassignTo ID: must be a number', null);
      }
      db.deleteTag(id, reassignTo as number | undefined);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to delete tag', { error, id, reassignTo });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('merge-tags', withContext('merge-tags', async (_, input: unknown) => {
    try {
      const parsed = mergeTagsSchema.safeParse(input);
      if (!parsed.success) {
        const errorMsg = `Invalid input: ${parsed.error.errors.map(e => e.message).join(', ')}`;
        logger.warn('merge-tags: Validation failed', { input, errors: parsed.error.errors });
        return ipcErr(errorMsg, null);
      }
      db.mergeTags(parsed.data.sourceId, parsed.data.targetId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to merge tags', { error, input });
      return ipcErr(error, null);
    }
  }));

  // ============================================================================
  // TAG PROPERTIES
  // ============================================================================

  ipcMain.handle('toggle-tag-pinned', withContext('toggle-tag-pinned', async (_, id: unknown) => {
    try {
      if (typeof id !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      const tag = db.toggleTagPinned(id);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to toggle tag pinned', { error, id });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('set-tag-color', withContext('set-tag-color', async (_, id: unknown, color: unknown) => {
    try {
      if (typeof id !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      if (typeof color !== 'string') {
        return ipcErr('Invalid color: must be a string', null);
      }
      const tag = db.setTagColor(id, color);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to set tag color', { error, id, color });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('set-tag-effect', withContext('set-tag-effect', async (_, id: unknown, effect: unknown) => {
    try {
      if (typeof id !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      const parsedEffect = tagEffectSchema.nullable().safeParse(effect);
      if (!parsedEffect.success) {
        const errorMsg = `Invalid effect: ${parsedEffect.error.errors.map(e => e.message).join(', ')}`;
        logger.warn('set-tag-effect: Validation failed', { id, effect, errors: parsedEffect.error.errors });
        return ipcErr(errorMsg, null);
      }
      const tag = db.setTagEffect(id, parsedEffect.data);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to set tag effect', { error, id, effect });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('create-tag-alias', withContext('create-tag-alias', async (_, aliasName: unknown, canonicalId: unknown) => {
    try {
      if (typeof aliasName !== 'string') {
        return ipcErr('Invalid alias name: must be a string', null);
      }
      if (typeof canonicalId !== 'number') {
        return ipcErr('Invalid canonical ID: must be a number', null);
      }
      const tag = db.createTagAlias(aliasName, canonicalId);
      return ipcOk(tag);
    } catch (error) {
      logger.error('Failed to create tag alias', { error, aliasName, canonicalId });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('get-tag-children', withContext('get-tag-children', async (_, parentId: unknown) => {
    try {
      if (typeof parentId !== 'number') {
        return ipcErr('Invalid parent ID: must be a number', []);
      }
      const tags = db.getTagChildren(parentId);
      return ipcOk(tags);
    } catch (error) {
      logger.error('Failed to get tag children', { error, parentId });
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('get-tag-aliases', withContext('get-tag-aliases', async (_, tagId: unknown) => {
    try {
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', []);
      }
      const tags = db.getTagAliases(tagId);
      return ipcOk(tags);
    } catch (error) {
      logger.error('Failed to get tag aliases', { error, tagId });
      return ipcErr(error, []);
    }
  }));

  // ============================================================================
  // SESSION-TAG ASSOCIATIONS
  // ============================================================================

  ipcMain.handle('add-tag-to-session', withContext('add-tag-to-session', async (_, sessionId: unknown, tagId: unknown) => {
    try {
      if (typeof sessionId !== 'string') {
        return ipcErr('Invalid session ID: must be a string', null);
      }
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.addTagToSession(sessionId, tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to add tag to session', { error, sessionId, tagId });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('remove-tag-from-session', withContext('remove-tag-from-session', async (_, sessionId: unknown, tagId: unknown) => {
    try {
      if (typeof sessionId !== 'string') {
        return ipcErr('Invalid session ID: must be a string', null);
      }
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.removeTagFromSession(sessionId, tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to remove tag from session', { error, sessionId, tagId });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('get-session-tags', withContext('get-session-tags', async (_, sessionId: unknown) => {
    try {
      if (typeof sessionId !== 'string') {
        return ipcErr('Invalid session ID: must be a string', []);
      }
      const tags = db.getSessionTags(sessionId);
      return ipcOk(tags);
    } catch (error) {
      logger.error('Failed to get session tags', { error, sessionId });
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('clear-session-tags', withContext('clear-session-tags', async (_, sessionId: unknown) => {
    try {
      if (typeof sessionId !== 'string') {
        return ipcErr('Invalid session ID: must be a string', null);
      }
      db.clearSessionTags(sessionId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to clear session tags', { error, sessionId });
      return ipcErr(error, null);
    }
  }));

  // ============================================================================
  // BULK OPERATIONS
  // ============================================================================

  ipcMain.handle('add-tag-to-sessions', withContext('add-tag-to-sessions', async (_, sessionIds: unknown, tagId: unknown) => {
    try {
      if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) {
        return ipcErr('Invalid session IDs: must be an array of strings', null);
      }
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.addTagToSessions(sessionIds, tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to add tag to sessions', { error, sessionIds, tagId });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('remove-tag-from-sessions', withContext('remove-tag-from-sessions', async (_, sessionIds: unknown, tagId: unknown) => {
    try {
      if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) {
        return ipcErr('Invalid session IDs: must be an array of strings', null);
      }
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.removeTagFromSessions(sessionIds, tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to remove tag from sessions', { error, sessionIds, tagId });
      return ipcErr(error, null);
    }
  }));

  // ============================================================================
  // RECENT/PINNED TAGS
  // ============================================================================

  ipcMain.handle('get-recent-tags', withContext('get-recent-tags', async (_, limit?: unknown) => {
    try {
      const validatedLimit = typeof limit === 'number' ? limit : 10;
      const tags = db.getRecentTags(validatedLimit);
      return ipcOk(tags);
    } catch (error) {
      logger.error('Failed to get recent tags', { error, limit });
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('get-pinned-tags', withContext('get-pinned-tags', async () => {
    try {
      const tags = db.getPinnedTags();
      return ipcOk(tags);
    } catch (error) {
      logger.error('Failed to get pinned tags', { error });
      return ipcErr(error, []);
    }
  }));

  ipcMain.handle('record-tag-usage', withContext('record-tag-usage', async (_, tagId: unknown) => {
    try {
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.recordTagUsage(tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to record tag usage', { error, tagId });
      return ipcErr(error, null);
    }
  }));

  // ============================================================================
  // USAGE COUNT MANAGEMENT
  // ============================================================================

  ipcMain.handle('increment-tag-usage', withContext('increment-tag-usage', async (_, tagId: unknown) => {
    try {
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.incrementTagUsage(tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to increment tag usage', { error, tagId });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('decrement-tag-usage', withContext('decrement-tag-usage', async (_, tagId: unknown) => {
    try {
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.decrementTagUsage(tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to decrement tag usage', { error, tagId });
      return ipcErr(error, null);
    }
  }));

  ipcMain.handle('recalculate-tag-usage', withContext('recalculate-tag-usage', async (_, tagId: unknown) => {
    try {
      if (typeof tagId !== 'number') {
        return ipcErr('Invalid tag ID: must be a number', null);
      }
      db.recalculateTagUsageCount(tagId);
      return ipcOk(true);
    } catch (error) {
      logger.error('Failed to recalculate tag usage', { error, tagId });
      return ipcErr(error, null);
    }
  }));

  logger.info('Tag handlers registered');
}
