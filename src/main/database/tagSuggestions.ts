// ============================================================================
// DATABASE - Tag Suggestion Operations
// ============================================================================

import { getDatabase } from './connection.js';
import { Logger } from '../services/logger.js';
import type { TagSuggestion, SuggestionFeedback, SuggestionStatus } from '../../shared/types/index.js';
import type { ScanStatus } from '../../shared/types/tag-types.js';
import { mapRowToTagSuggestion, mapRowToSuggestionFeedback, type TagSuggestionRow, type SuggestionFeedbackRow } from './mappers.js';
import { createTag, addTagToSession } from './tags.js';

const logger = new Logger('Database:TagSuggestions');

// ============================================================================
// SUGGESTION CRUD
// ============================================================================

/**
 * Create multiple suggestions for a session
 */
export function createSuggestions(suggestions: Array<{
  sessionId: string;
  tagName: string;
  confidence: number;
  category?: string;
  reasoning?: string;
}>): TagSuggestion[] {
  const database = getDatabase();
  const results: TagSuggestion[] = [];

  try {
    database.transaction(() => {
      for (const suggestion of suggestions) {
        const result = database.prepare(`
          INSERT INTO tag_suggestions (
            session_id, tag_name, confidence, category, reasoning, status
          ) VALUES (?, ?, ?, ?, ?, 'pending')
        `).run(
          suggestion.sessionId,
          suggestion.tagName,
          suggestion.confidence,
          suggestion.category ?? null,
          suggestion.reasoning ?? null
        );

        const row = database.prepare(`
          SELECT * FROM tag_suggestions WHERE id = ?
        `).get(result.lastInsertRowid) as TagSuggestionRow;

        results.push(mapRowToTagSuggestion(row));
      }
    })();

    logger.debug(`Created ${results.length} suggestions for session ${suggestions[0]?.sessionId}`);
    return results;
  } catch (error) {
    logger.error('Failed to create suggestions', error, {
      sessionId: suggestions[0]?.sessionId,
      count: suggestions.length,
    });
    throw error;
  }
}

/**
 * Get all suggestions for a session
 */
export function getSessionSuggestions(sessionId: string): TagSuggestion[] {
  const database = getDatabase();
  const rows = database.prepare(`
    SELECT * FROM tag_suggestions
    WHERE session_id = ?
    ORDER BY confidence DESC, created_at ASC
  `).all(sessionId) as TagSuggestionRow[];
  return rows.map(mapRowToTagSuggestion);
}

/**
 * Get a single suggestion by ID
 */
export function getSuggestion(id: number): TagSuggestion | null {
  const database = getDatabase();
  const row = database.prepare(`
    SELECT * FROM tag_suggestions WHERE id = ?
  `).get(id) as TagSuggestionRow | undefined;
  return row ? mapRowToTagSuggestion(row) : null;
}

/**
 * Update suggestion status
 */
export function updateSuggestionStatus(
  id: number,
  status: SuggestionStatus,
  reviewedAt?: string
): void {
  const database = getDatabase();
  database.prepare(`
    UPDATE tag_suggestions
    SET status = ?, reviewed_at = ?
    WHERE id = ?
  `).run(status, reviewedAt ?? new Date().toISOString(), id);
}

/**
 * Accept a suggestion (creates tag if needed, applies to session)
 */
export function acceptSuggestion(id: number): void {
  const database = getDatabase();

  try {
    database.transaction(() => {
      // Get the suggestion
      const suggestion = getSuggestion(id);
      if (!suggestion) {
        throw new Error(`Suggestion ${id} not found`);
      }

      // Check if tag exists, create if not
      const existingTag = database.prepare(`
        SELECT id FROM tags WHERE name = ?
      `).get(suggestion.tagName) as { id: number } | undefined;

      let tagId: number;
      if (existingTag) {
        tagId = existingTag.id;
      } else {
        // Create tag with default color (ai-suggested tags get a distinct color)
        const newTag = createTag({
          name: suggestion.tagName,
          color: '#9333ea',
        });
        tagId = newTag.id;
        logger.debug(`Created new tag: ${suggestion.tagName} (id: ${tagId})`);
      }

      // Add tag to session
      const added = addTagToSession(suggestion.sessionId, tagId);
      if (!added) {
        logger.debug(`Tag ${suggestion.tagName} already applied to session ${suggestion.sessionId}`);
      }

      // Update suggestion status
      updateSuggestionStatus(id, 'accepted');

      // Record positive feedback
      recordSuggestionFeedback(suggestion.tagName, null, true);

      logger.debug(`Accepted suggestion ${id}: ${suggestion.tagName} for session ${suggestion.sessionId}`);
    })();
  } catch (error) {
    logger.error('Failed to accept suggestion', error, { suggestionId: id });
    throw error;
  }
}

/**
 * Reject a suggestion
 */
export function rejectSuggestion(id: number): void {
  const database = getDatabase();

  try {
    const suggestion = getSuggestion(id);
    if (!suggestion) {
      throw new Error(`Suggestion ${id} not found`);
    }

    updateSuggestionStatus(id, 'rejected');
    recordSuggestionFeedback(suggestion.tagName, null, false);

    logger.debug(`Rejected suggestion ${id}: ${suggestion.tagName}`);
  } catch (error) {
    logger.error('Failed to reject suggestion', error, { suggestionId: id });
    throw error;
  }
}

/**
 * Dismiss a suggestion (don't show again, but don't count as rejection)
 */
export function dismissSuggestion(id: number): void {
  const database = getDatabase();
  updateSuggestionStatus(id, 'dismissed');
  logger.debug(`Dismissed suggestion ${id}`);
}

/**
 * Accept all pending suggestions for a session
 */
export function acceptAllSuggestions(sessionId: string): number {
  const database = getDatabase();

  try {
    const pendingSuggestions = database.prepare(`
      SELECT id FROM tag_suggestions
      WHERE session_id = ? AND status = 'pending'
    `).all(sessionId) as Array<{ id: number }>;

    let acceptedCount = 0;
    for (const suggestion of pendingSuggestions) {
      try {
        acceptSuggestion(suggestion.id);
        acceptedCount++;
      } catch (error) {
        logger.warn(`Failed to accept suggestion ${suggestion.id}`, { error });
      }
    }

    logger.debug(`Accepted ${acceptedCount}/${pendingSuggestions.length} suggestions for session ${sessionId}`);
    return acceptedCount;
  } catch (error) {
    logger.error('Failed to accept all suggestions', error, { sessionId });
    throw error;
  }
}

/**
 * Dismiss all pending suggestions for a session
 */
export function dismissAllSuggestions(sessionId: string): number {
  const database = getDatabase();

  const result = database.prepare(`
    UPDATE tag_suggestions
    SET status = 'dismissed', reviewed_at = datetime('now')
    WHERE session_id = ? AND status = 'pending'
  `).run(sessionId);

  logger.debug(`Dismissed ${result.changes} suggestions for session ${sessionId}`);
  return result.changes;
}

/**
 * Delete old suggestions (cleanup)
 */
export function deleteOldSuggestions(olderThanDays: number): number {
  const database = getDatabase();

  const result = database.prepare(`
    DELETE FROM tag_suggestions
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(olderThanDays);

  logger.debug(`Deleted ${result.changes} suggestions older than ${olderThanDays} days`);
  return result.changes;
}

// ============================================================================
// FEEDBACK
// ============================================================================

/**
 * Record feedback for suggestion learning
 */
export function recordSuggestionFeedback(
  tagName: string,
  contextHash: string | null,
  accepted: boolean
): void {
  const database = getDatabase();

  try {
    database.transaction(() => {
      // Check if feedback entry exists
      const existing = database.prepare(`
        SELECT id, accepted_count, rejected_count
        FROM suggestion_feedback
        WHERE tag_name = ? AND context_hash IS ?
      `).get(tagName, contextHash) as { id: number; accepted_count: number; rejected_count: number } | undefined;

      if (existing) {
        // Update existing feedback
        if (accepted) {
          database.prepare(`
            UPDATE suggestion_feedback
            SET accepted_count = accepted_count + 1, last_feedback_at = datetime('now')
            WHERE id = ?
          `).run(existing.id);
        } else {
          database.prepare(`
            UPDATE suggestion_feedback
            SET rejected_count = rejected_count + 1, last_feedback_at = datetime('now')
            WHERE id = ?
          `).run(existing.id);
        }
      } else {
        // Create new feedback entry
        database.prepare(`
          INSERT INTO suggestion_feedback (
            tag_name, context_hash, accepted_count, rejected_count, last_feedback_at
          ) VALUES (?, ?, ?, ?, datetime('now'))
        `).run(
          tagName,
          contextHash,
          accepted ? 1 : 0,
          accepted ? 0 : 1
        );
      }
    })();
  } catch (error) {
    logger.error('Failed to record suggestion feedback', error, { tagName, accepted });
    throw error;
  }
}

/**
 * Get feedback for a tag in a context
 */
export function getSuggestionFeedback(
  tagName: string,
  contextHash: string | null
): SuggestionFeedback | null {
  const database = getDatabase();
  const row = database.prepare(`
    SELECT * FROM suggestion_feedback
    WHERE tag_name = ? AND context_hash IS ?
  `).get(tagName, contextHash) as SuggestionFeedbackRow | undefined;
  return row ? mapRowToSuggestionFeedback(row) : null;
}

/**
 * Check if a tag was frequently rejected in similar contexts
 */
export function isTagFrequentlyRejected(
  tagName: string,
  contextHash: string | null,
  threshold = 0.7
): boolean {
  const feedback = getSuggestionFeedback(tagName, contextHash);
  if (!feedback) {
    return false;
  }

  const totalFeedback = feedback.acceptedCount + feedback.rejectedCount;
  if (totalFeedback < 3) {
    // Not enough data to determine
    return false;
  }

  const rejectionRate = feedback.rejectedCount / totalFeedback;
  return rejectionRate >= threshold;
}

// ============================================================================
// SCAN STATUS
// ============================================================================

/**
 * Update session scan status
 */
export function updateSessionScanStatus(
  sessionId: string,
  status: ScanStatus,
  depth?: 'quick' | 'full'
): void {
  const database = getDatabase();

  database.prepare(`
    UPDATE sessions
    SET suggestion_scan_status = ?, suggestion_scanned_at = datetime('now'), suggestion_scan_depth = ?
    WHERE id = ?
  `).run(status, depth ?? null, sessionId);
}

/**
 * Get sessions pending scan (LIFO order - newest first)
 * Prioritizes user sessions over agent sessions
 */
export function getPendingSessions(limit = 10): string[] {
  const database = getDatabase();

  const rows = database.prepare(`
    SELECT id FROM sessions
    WHERE suggestion_scan_status = 'pending' OR suggestion_scan_status IS NULL
    ORDER BY 
      CASE WHEN id LIKE 'agent-%' THEN 1 ELSE 0 END,
      end_time DESC, 
      updated_at DESC
    LIMIT ?
  `).all(limit) as Array<{ id: string }>;

  return rows.map(row => row.id);
}

/**
 * Get sessions that need re-scanning (were updated after last scan)
 */
export function getSessionsNeedingRescan(): string[] {
  const database = getDatabase();

  const rows = database.prepare(`
    SELECT id FROM sessions
    WHERE suggestion_scan_status = 'completed'
      AND suggestion_scanned_at IS NOT NULL
      AND updated_at > suggestion_scanned_at
    ORDER BY updated_at DESC
  `).all() as Array<{ id: string }>;

  return rows.map(row => row.id);
}

/**
 * Get count of scanned vs unscanned sessions
 */
export function getScanCounts(): { scanned: number; pending: number; total: number } {
  const database = getDatabase();

  const scanned = database.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE suggestion_scan_status = 'completed'
  `).get() as { count: number };

  const pending = database.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE suggestion_scan_status = 'pending' OR suggestion_scan_status IS NULL
  `).get() as { count: number };

  const total = database.prepare(`
    SELECT COUNT(*) as count FROM sessions
  `).get() as { count: number };

  return {
    scanned: scanned.count,
    pending: pending.count,
    total: total.count,
  };
}

/**
 * Get detailed scan status for a session
 */
export function getSessionScanStatus(
  sessionId: string
): { status: ScanStatus; scannedAt: string | null; depth: string | null } | null {
  const database = getDatabase();

  const row = database.prepare(`
    SELECT suggestion_scan_status, suggestion_scanned_at, suggestion_scan_depth FROM sessions WHERE id = ?
  `).get(sessionId) as { suggestion_scan_status: string | null; suggestion_scanned_at: string | null; suggestion_scan_depth: string | null } | undefined;

  if (!row) {
    return null;
  }

  return {
    status: ((row.suggestion_scan_status as unknown as ScanStatus) || 'pending') as ScanStatus,
    scannedAt: row.suggestion_scanned_at,
    depth: row.suggestion_scan_depth,
  };
}

/**
 * Mark sessions older than X as skipped (for large backlogs)
 */
export function skipOldSessions(olderThanDays: number): number {
  const database = getDatabase();

  const result = database.prepare(`
    UPDATE sessions
    SET suggestion_scan_status = 'skipped'
    WHERE (suggestion_scan_status = 'pending' OR suggestion_scan_status IS NULL)
      AND end_time < datetime('now', '-' || ? || ' days')
  `).run(olderThanDays);

  logger.debug(`Skipped ${result.changes} sessions older than ${olderThanDays} days`);
  return result.changes;
}
