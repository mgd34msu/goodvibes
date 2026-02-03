// ============================================================================
// DATABASE - Tag Operations
// ============================================================================

import { getDatabase } from './connection.js';
import { Logger } from '../services/logger.js';
import type { Tag, CreateTagInput, UpdateTagInput, TagEffect } from '../../shared/types/index.js';
import { mapRowToTag, type TagRow } from './mappers.js';

const logger = new Logger('Database:Tags');

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalizes tag names: trim whitespace and convert to lowercase
 */
function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}

// ============================================================================
// TAG CRUD OPERATIONS
// ============================================================================

/**
 * Get all tags, ordered by pinned status, usage count, then name
 */
export function getAllTags(): Tag[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM tags 
    ORDER BY is_pinned DESC, usage_count DESC, name ASC
  `).all() as TagRow[];
  return rows.map(mapRowToTag);
}

/**
 * Get a single tag by ID
 */
export function getTag(id: number): Tag | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
  return row ? mapRowToTag(row) : null;
}

/**
 * Get a tag by name (case-insensitive)
 */
export function getTagByName(name: string): Tag | null {
  const db = getDatabase();
  const normalizedName = normalizeTagName(name);
  const row = db.prepare('SELECT * FROM tags WHERE LOWER(name) = ?').get(normalizedName) as TagRow | undefined;
  return row ? mapRowToTag(row) : null;
}

/**
 * Create a new tag
 */
export function createTag(input: CreateTagInput): Tag {
  const db = getDatabase();
  const normalizedName = normalizeTagName(input.name);
  
  // Check if tag already exists
  const existing = getTagByName(normalizedName);
  if (existing) {
    logger.warn(`Tag already exists: ${normalizedName}`);
    return existing;
  }
  
  try {
    const result = db.prepare(`
      INSERT INTO tags (name, color, effect, parent_id, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      normalizedName,
      input.color ?? '#808080',
      input.effect ?? null,
      input.parentId ?? null,
      input.description ?? null
    );
    
    const tag = getTag(result.lastInsertRowid as number);
    if (!tag) {
      throw new Error('Failed to retrieve newly created tag');
    }
    
    logger.info(`Created tag: ${tag.name}`, { tagId: tag.id });
    return tag;
  } catch (error) {
    logger.error('Failed to create tag', error, { input });
    throw error;
  }
}

/**
 * Update an existing tag
 */
export function updateTag(id: number, input: UpdateTagInput): Tag {
  const db = getDatabase();
  const existing = getTag(id);
  
  if (!existing) {
    throw new Error(`Tag not found: ${id}`);
  }
  
  // If updating name, normalize and check for duplicates
  if (input.name !== undefined) {
    const normalizedName = normalizeTagName(input.name);
    const duplicate = getTagByName(normalizedName);
    if (duplicate && duplicate.id !== id) {
      throw new Error(`Tag name already exists: ${normalizedName}`);
    }
  }
  
  try {
    const updates: string[] = [];
    const values: unknown[] = [];
    
    if (input.name !== undefined) {
      updates.push('name = ?');
      values.push(normalizeTagName(input.name));
    }
    if (input.color !== undefined) {
      updates.push('color = ?');
      values.push(input.color);
    }
    if (input.effect !== undefined) {
      updates.push('effect = ?');
      values.push(input.effect);
    }
    if (input.parentId !== undefined) {
      updates.push('parent_id = ?');
      values.push(input.parentId);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }
    
    if (updates.length === 0) {
      return existing;
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    
    db.prepare(`
      UPDATE tags SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);
    
    const updated = getTag(id);
    if (!updated) {
      throw new Error('Failed to retrieve updated tag');
    }
    
    logger.info(`Updated tag: ${updated.name}`, { tagId: id });
    return updated;
  } catch (error) {
    logger.error('Failed to update tag', error, { id, input });
    throw error;
  }
}

/**
 * Delete a tag, optionally reassigning sessions to another tag
 */
export function deleteTag(id: number, reassignTo?: number): void {
  const db = getDatabase();
  const tag = getTag(id);
  
  if (!tag) {
    throw new Error(`Tag not found: ${id}`);
  }
  
  try {
    db.transaction(() => {
      if (reassignTo !== undefined) {
        const targetTag = getTag(reassignTo);
        if (!targetTag) {
          throw new Error(`Target tag not found: ${reassignTo}`);
        }
        
        // Reassign all session associations to target tag
        db.prepare(`
          UPDATE OR IGNORE session_tags 
          SET tag_id = ? 
          WHERE tag_id = ?
        `).run(reassignTo, id);
        
        // Delete any duplicates that couldn't be updated
        db.prepare('DELETE FROM session_tags WHERE tag_id = ?').run(id);
        
        // Recalculate usage count for target tag
        recalculateTagUsageCount(reassignTo);
      } else {
        // Just delete all associations
        db.prepare('DELETE FROM session_tags WHERE tag_id = ?').run(id);
      }
      
      // Delete the tag itself
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
      
      logger.info(`Deleted tag: ${tag.name}`, { tagId: id, reassignedTo: reassignTo });
    })();
  } catch (error) {
    logger.error('Failed to delete tag', error, { id, reassignTo });
    throw error;
  }
}

/**
 * Merge two tags: move all associations from source to target, delete source
 */
export function mergeTags(sourceId: number, targetId: number): Tag {
  const db = getDatabase();
  const source = getTag(sourceId);
  const target = getTag(targetId);
  
  if (!source) {
    throw new Error(`Source tag not found: ${sourceId}`);
  }
  if (!target) {
    throw new Error(`Target tag not found: ${targetId}`);
  }
  if (sourceId === targetId) {
    throw new Error('Cannot merge a tag with itself');
  }
  
  try {
    db.transaction(() => {
      // Move all session associations from source to target
      db.prepare(`
        UPDATE OR IGNORE session_tags 
        SET tag_id = ? 
        WHERE tag_id = ?
      `).run(targetId, sourceId);
      
      // Delete any duplicate associations
      db.prepare('DELETE FROM session_tags WHERE tag_id = ?').run(sourceId);
      
      // Delete source tag
      db.prepare('DELETE FROM tags WHERE id = ?').run(sourceId);
      
      // Recalculate usage count for target
      recalculateTagUsageCount(targetId);
      
      logger.info(`Merged tags: ${source.name} -> ${target.name}`, { sourceId, targetId });
    })();
    
    const updated = getTag(targetId);
    if (!updated) {
      throw new Error('Failed to retrieve merged tag');
    }
    return updated;
  } catch (error) {
    logger.error('Failed to merge tags', error, { sourceId, targetId });
    throw error;
  }
}

// ============================================================================
// TAG PROPERTIES
// ============================================================================

/**
 * Toggle pinned status for a tag
 */
export function toggleTagPinned(id: number): Tag {
  const db = getDatabase();
  const tag = getTag(id);
  
  if (!tag) {
    throw new Error(`Tag not found: ${id}`);
  }
  
  db.prepare(`
    UPDATE tags 
    SET is_pinned = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(tag.isPinned ? 0 : 1, id);
  
  const updated = getTag(id);
  if (!updated) {
    throw new Error('Failed to retrieve updated tag');
  }
  
  logger.info(`Toggled pin for tag: ${tag.name}`, { tagId: id, isPinned: updated.isPinned });
  return updated;
}

/**
 * Set tag color
 */
export function setTagColor(id: number, color: string | null): Tag {
  const db = getDatabase();
  const tag = getTag(id);
  
  if (!tag) {
    throw new Error(`Tag not found: ${id}`);
  }
  
  db.prepare(`
    UPDATE tags 
    SET color = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(color ?? '#808080', id);
  
  const updated = getTag(id);
  if (!updated) {
    throw new Error('Failed to retrieve updated tag');
  }
  
  return updated;
}

/**
 * Set tag effect
 */
export function setTagEffect(id: number, effect: TagEffect | null): Tag {
  const db = getDatabase();
  const tag = getTag(id);
  
  if (!tag) {
    throw new Error(`Tag not found: ${id}`);
  }
  
  db.prepare(`
    UPDATE tags 
    SET effect = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(effect, id);
  
  const updated = getTag(id);
  if (!updated) {
    throw new Error('Failed to retrieve updated tag');
  }
  
  return updated;
}

/**
 * Set tag parent (for hierarchy)
 */
export function setTagParent(id: number, parentId: number | null): Tag {
  const db = getDatabase();
  const tag = getTag(id);
  
  if (!tag) {
    throw new Error(`Tag not found: ${id}`);
  }
  
  if (parentId !== null) {
    const parent = getTag(parentId);
    if (!parent) {
      throw new Error(`Parent tag not found: ${parentId}`);
    }
    if (parentId === id) {
      throw new Error('A tag cannot be its own parent');
    }
  }
  
  db.prepare(`
    UPDATE tags 
    SET parent_id = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(parentId, id);
  
  const updated = getTag(id);
  if (!updated) {
    throw new Error('Failed to retrieve updated tag');
  }
  
  return updated;
}

/**
 * Create an alias pointing to a canonical tag
 */
export function createTagAlias(aliasName: string, canonicalId: number): Tag {
  const db = getDatabase();
  const normalizedName = normalizeTagName(aliasName);
  
  // Check if alias name already exists
  const existing = getTagByName(normalizedName);
  if (existing) {
    throw new Error(`Tag name already exists: ${normalizedName}`);
  }
  
  // Check if canonical tag exists
  const canonical = getTag(canonicalId);
  if (!canonical) {
    throw new Error(`Canonical tag not found: ${canonicalId}`);
  }
  
  try {
    const result = db.prepare(`
      INSERT INTO tags (name, color, alias_of)
      VALUES (?, ?, ?)
    `).run(normalizedName, canonical.color, canonicalId);
    
    const alias = getTag(result.lastInsertRowid as number);
    if (!alias) {
      throw new Error('Failed to retrieve newly created alias');
    }
    
    logger.info(`Created alias: ${alias.name} -> ${canonical.name}`, { aliasId: alias.id, canonicalId });
    return alias;
  } catch (error) {
    logger.error('Failed to create alias', error, { aliasName, canonicalId });
    throw error;
  }
}

/**
 * Get all children of a parent tag
 */
export function getTagChildren(parentId: number): Tag[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM tags 
    WHERE parent_id = ? 
    ORDER BY name ASC
  `).all(parentId) as TagRow[];
  return rows.map(mapRowToTag);
}

/**
 * Get all aliases of a tag
 */
export function getTagAliases(tagId: number): Tag[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM tags 
    WHERE alias_of = ? 
    ORDER BY name ASC
  `).all(tagId) as TagRow[];
  return rows.map(mapRowToTag);
}

// ============================================================================
// SESSION-TAG ASSOCIATIONS
// ============================================================================

/**
 * Add a tag to a session
 * Returns true if created, false if already exists
 */
export function addTagToSession(sessionId: string, tagId: number): boolean {
  const db = getDatabase();
  
  // Verify tag exists
  const tag = getTag(tagId);
  if (!tag) {
    throw new Error(`Tag not found: ${tagId}`);
  }
  
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO session_tags (session_id, tag_id) 
      VALUES (?, ?)
    `).run(sessionId, tagId);
    
    const created = result.changes > 0;
    
    if (created) {
      // Increment usage count and record usage
      incrementTagUsage(tagId);
      recordTagUsage(tagId);
      logger.debug(`Added tag to session: ${tag.name}`, { sessionId, tagId });
    }
    
    return created;
  } catch (error) {
    logger.error('Failed to add tag to session', error, { sessionId, tagId });
    throw error;
  }
}

/**
 * Remove a tag from a session
 */
export function removeTagFromSession(sessionId: string, tagId: number): void {
  const db = getDatabase();
  
  const result = db.prepare(`
    DELETE FROM session_tags 
    WHERE session_id = ? AND tag_id = ?
  `).run(sessionId, tagId);
  
  if (result.changes > 0) {
    decrementTagUsage(tagId);
    logger.debug(`Removed tag from session`, { sessionId, tagId });
  }
}

/**
 * Get all tags for a session
 */
export function getSessionTags(sessionId: string): Tag[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT t.* FROM tags t
    JOIN session_tags st ON t.id = st.tag_id
    WHERE st.session_id = ?
    ORDER BY t.name ASC
  `).all(sessionId) as TagRow[];
  return rows.map(mapRowToTag);
}

/**
 * Clear all tags from a session
 */
export function clearSessionTags(sessionId: string): void {
  const db = getDatabase();
  
  // Get all tag IDs before deleting
  const tagIds = db.prepare(`
    SELECT tag_id FROM session_tags WHERE session_id = ?
  `).all(sessionId) as Array<{ tag_id: number }>;
  
  if (tagIds.length === 0) {
    return;
  }
  
  db.prepare('DELETE FROM session_tags WHERE session_id = ?').run(sessionId);
  
  // Decrement usage count for each tag
  for (const { tag_id } of tagIds) {
    decrementTagUsage(tag_id);
  }
  
  logger.debug(`Cleared all tags from session`, { sessionId, count: tagIds.length });
}

/**
 * Set session tags (atomic replace)
 */
export function setSessionTags(sessionId: string, tagIds: number[]): void {
  const db = getDatabase();
  
  try {
    db.transaction(() => {
      // Clear existing tags
      clearSessionTags(sessionId);
      
      // Add new tags
      for (const tagId of tagIds) {
        addTagToSession(sessionId, tagId);
      }
    })();
    
    logger.debug(`Set session tags`, { sessionId, count: tagIds.length });
  } catch (error) {
    logger.error('Failed to set session tags', error, { sessionId, tagIds });
    throw error;
  }
}

// ============================================================================
// BULK OPERATIONS
// ============================================================================

/**
 * Add a tag to multiple sessions
 * Returns the number of sessions that received the tag
 */
export function addTagToSessions(sessionIds: string[], tagId: number): number {
  const db = getDatabase();
  const tag = getTag(tagId);
  
  if (!tag) {
    throw new Error(`Tag not found: ${tagId}`);
  }
  
  let addedCount = 0;
  
  try {
    db.transaction(() => {
      for (const sessionId of sessionIds) {
        if (addTagToSession(sessionId, tagId)) {
          addedCount++;
        }
      }
    })();
    
    logger.info(`Bulk added tag to sessions: ${tag.name}`, { tagId, sessionCount: addedCount });
    return addedCount;
  } catch (error) {
    logger.error('Failed to bulk add tag to sessions', error, { sessionIds, tagId });
    throw error;
  }
}

/**
 * Remove a tag from multiple sessions
 * Returns the number of sessions the tag was removed from
 */
export function removeTagFromSessions(sessionIds: string[], tagId: number): number {
  const db = getDatabase();
  
  let removedCount = 0;
  
  try {
    db.transaction(() => {
      for (const sessionId of sessionIds) {
        const result = db.prepare(`
          DELETE FROM session_tags 
          WHERE session_id = ? AND tag_id = ?
        `).run(sessionId, tagId);
        
        if (result.changes > 0) {
          removedCount++;
        }
      }
      
      // Recalculate usage count
      if (removedCount > 0) {
        recalculateTagUsageCount(tagId);
      }
    })();
    
    logger.info(`Bulk removed tag from sessions`, { tagId, sessionCount: removedCount });
    return removedCount;
  } catch (error) {
    logger.error('Failed to bulk remove tag from sessions', error, { sessionIds, tagId });
    throw error;
  }
}

/**
 * Clear all tags from multiple sessions
 */
export function clearTagsFromSessions(sessionIds: string[]): void {
  const db = getDatabase();
  
  try {
    db.transaction(() => {
      for (const sessionId of sessionIds) {
        clearSessionTags(sessionId);
      }
    })();
    
    logger.info(`Bulk cleared tags from sessions`, { sessionCount: sessionIds.length });
  } catch (error) {
    logger.error('Failed to bulk clear tags', error, { sessionIds });
    throw error;
  }
}

// ============================================================================
// RECENT & PINNED TAGS
// ============================================================================

/**
 * Get recent tags, ordered by most recently used
 */
export function getRecentTags(limit: number = 10): Tag[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT DISTINCT t.* FROM tags t
    JOIN recent_tags rt ON t.id = rt.tag_id
    ORDER BY rt.used_at DESC
    LIMIT ?
  `).all(limit) as TagRow[];
  return rows.map(mapRowToTag);
}

/**
 * Record tag usage (for recent tags tracking)
 */
export function recordTagUsage(tagId: number): void {
  const db = getDatabase();
  
  db.prepare(`
    INSERT INTO recent_tags (tag_id, used_at) 
    VALUES (?, CURRENT_TIMESTAMP)
  `).run(tagId);
  
  // Clean up old entries (keep last 100 per tag)
  db.prepare(`
    DELETE FROM recent_tags 
    WHERE id NOT IN (
      SELECT id FROM recent_tags 
      WHERE tag_id = ? 
      ORDER BY used_at DESC 
      LIMIT 100
    ) AND tag_id = ?
  `).run(tagId, tagId);
}

/**
 * Get all pinned tags
 */
export function getPinnedTags(): Tag[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM tags 
    WHERE is_pinned = 1 
    ORDER BY name ASC
  `).all() as TagRow[];
  return rows.map(mapRowToTag);
}

// ============================================================================
// USAGE COUNT MANAGEMENT
// ============================================================================

/**
 * Increment usage count for a tag
 */
export function incrementTagUsage(tagId: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE tags 
    SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(tagId);
}

/**
 * Decrement usage count for a tag
 */
export function decrementTagUsage(tagId: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE tags 
    SET usage_count = MAX(0, usage_count - 1), updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(tagId);
}

/**
 * Recalculate usage count from session_tags
 */
export function recalculateTagUsageCount(tagId: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE tags 
    SET usage_count = (
      SELECT COUNT(*) FROM session_tags WHERE tag_id = ?
    ),
    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(tagId, tagId);
}

/**
 * Recalculate all tag usage counts
 */
export function recalculateAllTagUsageCounts(): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE tags 
    SET usage_count = (
      SELECT COUNT(*) FROM session_tags WHERE session_tags.tag_id = tags.id
    ),
    updated_at = CURRENT_TIMESTAMP
  `).run();
  
  logger.info('Recalculated all tag usage counts');
}
