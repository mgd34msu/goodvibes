// ============================================================================
// RECOMMENDATIONS DATABASE - Tracking and feedback for agent recommendations
// ============================================================================
//
// This module provides database operations for storing recommendation events,
// tracking user feedback (accept/reject/ignore), and calculating recommendation
// accuracy statistics over time.
//
// ============================================================================

import { getDatabase } from './connection.js';
import { Logger } from '../services/logger.js';

const logger = new Logger('RecommendationsDB');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Type of recommendation being made
 */
export type RecommendationType = 'agent' | 'skill';

/**
 * User action on a recommendation
 */
export type RecommendationAction = 'accepted' | 'rejected' | 'ignored';

/**
 * Source of the recommendation trigger
 */
export type RecommendationSource = 'prompt' | 'project' | 'context' | 'historical';

/**
 * A recommendation event record
 */
export interface RecommendationRecord {
  id: number;
  sessionId: string | null;
  projectPath: string | null;
  recommendationType: RecommendationType;
  itemId: number;  // agentId or skillId
  itemSlug: string;
  itemName: string;
  confidenceScore: number;  // 0.0 to 1.0
  source: RecommendationSource;
  matchedKeywords: string;  // JSON array of matched keywords
  promptSnippet: string | null;  // First 200 chars of triggering prompt
  action: RecommendationAction | null;  // null = pending
  actionTimestamp: string | null;
  createdAt: string;
}

/**
 * Statistics for recommendation accuracy
 */
export interface RecommendationStats {
  totalRecommendations: number;
  acceptedCount: number;
  rejectedCount: number;
  ignoredCount: number;
  pendingCount: number;
  acceptanceRate: number;  // 0.0 to 1.0
  byType: {
    agent: { total: number; accepted: number; rate: number };
    skill: { total: number; accepted: number; rate: number };
  };
  bySource: {
    prompt: { total: number; accepted: number; rate: number };
    project: { total: number; accepted: number; rate: number };
    context: { total: number; accepted: number; rate: number };
    historical: { total: number; accepted: number; rate: number };
  };
  topAcceptedItems: Array<{
    itemId: number;
    itemSlug: string;
    itemName: string;
    type: RecommendationType;
    acceptedCount: number;
  }>;
}

/**
 * Historical success rate for an item
 */
export interface ItemSuccessRate {
  itemId: number;
  itemSlug: string;
  itemName: string;
  type: RecommendationType;
  totalRecommendations: number;
  acceptedCount: number;
  successRate: number;
}

/**
 * Database row type for recommendations table
 */
interface RecommendationRow {
  id: number;
  session_id: string | null;
  project_path: string | null;
  recommendation_type: RecommendationType;
  item_id: number;
  item_slug: string;
  item_name: string;
  confidence_score: number;
  source: RecommendationSource;
  matched_keywords: string;
  prompt_snippet: string | null;
  action: RecommendationAction | null;
  action_timestamp: string | null;
  created_at: string;
}

/**
 * Database row type for stats queries
 */
interface StatsRow {
  total: number;
  accepted: number;
  rejected: number;
  ignored: number;
  pending: number;
}

/**
 * Database row type for by-type stats
 */
interface TypeStatsRow {
  type: RecommendationType;
  total: number;
  accepted: number;
}

/**
 * Database row type for by-source stats
 */
interface SourceStatsRow {
  source: RecommendationSource;
  total: number;
  accepted: number;
}

/**
 * Database row type for top items
 */
interface TopItemRow {
  item_id: number;
  item_slug: string;
  item_name: string;
  type: RecommendationType;
  accepted_count: number;
}

/**
 * Database row type for item success queries
 */
interface ItemSuccessRow {
  item_id: number;
  item_slug: string;
  item_name: string;
  type: RecommendationType;
  total: number;
  accepted: number;
}

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createRecommendationsTables(): void {
  const db = getDatabase();

  // Recommendations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project_path TEXT,
      recommendation_type TEXT NOT NULL CHECK (recommendation_type IN ('agent', 'skill')),
      item_id INTEGER NOT NULL,
      item_slug TEXT NOT NULL,
      item_name TEXT NOT NULL,
      confidence_score REAL NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
      source TEXT NOT NULL CHECK (source IN ('prompt', 'project', 'context', 'historical')),
      matched_keywords TEXT DEFAULT '[]',
      prompt_snippet TEXT,
      action TEXT CHECK (action IN ('accepted', 'rejected', 'ignored') OR action IS NULL),
      action_timestamp TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  createRecommendationsIndexes();

  logger.info('Recommendations tables created');
}

function createRecommendationsIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_recommendations_session ON recommendations(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_recommendations_project ON recommendations(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_recommendations_type ON recommendations(recommendation_type)',
    'CREATE INDEX IF NOT EXISTS idx_recommendations_item ON recommendations(item_id, recommendation_type)',
    'CREATE INDEX IF NOT EXISTS idx_recommendations_action ON recommendations(action)',
    'CREATE INDEX IF NOT EXISTS idx_recommendations_created ON recommendations(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_recommendations_score ON recommendations(confidence_score DESC)',
  ];

  for (const index of indexes) {
    try {
      db.exec(index);
    } catch (e) {
      const error = e as Error;
      if (!error.message?.includes('already exists')) {
        logger.warn(`Failed to create index: ${error.message}`);
      }
    }
  }
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Record a new recommendation
 */
export function recordRecommendation(
  recommendation: Omit<RecommendationRecord, 'id' | 'action' | 'actionTimestamp' | 'createdAt'>
): RecommendationRecord {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO recommendations (
      session_id, project_path, recommendation_type, item_id, item_slug,
      item_name, confidence_score, source, matched_keywords, prompt_snippet
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recommendation.sessionId,
    recommendation.projectPath,
    recommendation.recommendationType,
    recommendation.itemId,
    recommendation.itemSlug,
    recommendation.itemName,
    recommendation.confidenceScore,
    recommendation.source,
    recommendation.matchedKeywords,
    recommendation.promptSnippet
  );

  const inserted = getRecommendation(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve recommendation with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Get a recommendation by ID
 */
export function getRecommendation(id: number): RecommendationRecord | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id) as RecommendationRow | undefined;
  return row ? mapRowToRecommendation(row) : null;
}

/**
 * Record user action on a recommendation
 */
export function recordRecommendationAction(
  id: number,
  action: RecommendationAction
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE recommendations SET
      action = ?,
      action_timestamp = datetime('now')
    WHERE id = ?
  `).run(action, id);
}

/**
 * Get recommendations for a session
 */
export function getRecommendationsForSession(
  sessionId: string,
  limit: number = 50
): RecommendationRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM recommendations
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sessionId, limit) as RecommendationRow[];
  return rows.map(mapRowToRecommendation);
}

/**
 * Get recent recommendations for a project
 */
export function getRecommendationsForProject(
  projectPath: string,
  limit: number = 50
): RecommendationRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM recommendations
    WHERE project_path = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(projectPath, limit) as RecommendationRow[];
  return rows.map(mapRowToRecommendation);
}

/**
 * Get pending recommendations (no action taken)
 */
export function getPendingRecommendations(
  sessionId?: string,
  limit: number = 20
): RecommendationRecord[] {
  const db = getDatabase();
  let query = 'SELECT * FROM recommendations WHERE action IS NULL';
  const params: (string | number)[] = [];

  if (sessionId) {
    query += ' AND session_id = ?';
    params.push(sessionId);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as RecommendationRow[];
  return rows.map(mapRowToRecommendation);
}

/**
 * Get all recommendations for an item
 */
export function getRecommendationsForItem(
  itemId: number,
  type: RecommendationType,
  limit: number = 100
): RecommendationRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM recommendations
    WHERE item_id = ? AND recommendation_type = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(itemId, type, limit) as RecommendationRow[];
  return rows.map(mapRowToRecommendation);
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get overall recommendation statistics
 */
export function getRecommendationStats(): RecommendationStats {
  const db = getDatabase();

  // Overall counts
  const overall = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN action = 'accepted' THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN action = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN action = 'ignored' THEN 1 ELSE 0 END) as ignored,
      SUM(CASE WHEN action IS NULL THEN 1 ELSE 0 END) as pending
    FROM recommendations
  `).get() as StatsRow;

  // By type
  const byTypeRows = db.prepare(`
    SELECT
      recommendation_type as type,
      COUNT(*) as total,
      SUM(CASE WHEN action = 'accepted' THEN 1 ELSE 0 END) as accepted
    FROM recommendations
    GROUP BY recommendation_type
  `).all() as TypeStatsRow[];

  const byType: RecommendationStats['byType'] = {
    agent: { total: 0, accepted: 0, rate: 0 },
    skill: { total: 0, accepted: 0, rate: 0 },
  };

  for (const row of byTypeRows) {
    byType[row.type] = {
      total: row.total,
      accepted: row.accepted,
      rate: row.total > 0 ? row.accepted / row.total : 0,
    };
  }

  // By source
  const bySourceRows = db.prepare(`
    SELECT
      source,
      COUNT(*) as total,
      SUM(CASE WHEN action = 'accepted' THEN 1 ELSE 0 END) as accepted
    FROM recommendations
    GROUP BY source
  `).all() as SourceStatsRow[];

  const bySource: RecommendationStats['bySource'] = {
    prompt: { total: 0, accepted: 0, rate: 0 },
    project: { total: 0, accepted: 0, rate: 0 },
    context: { total: 0, accepted: 0, rate: 0 },
    historical: { total: 0, accepted: 0, rate: 0 },
  };

  for (const row of bySourceRows) {
    bySource[row.source] = {
      total: row.total,
      accepted: row.accepted,
      rate: row.total > 0 ? row.accepted / row.total : 0,
    };
  }

  // Top accepted items
  const topItems = db.prepare(`
    SELECT
      item_id, item_slug, item_name, recommendation_type as type,
      SUM(CASE WHEN action = 'accepted' THEN 1 ELSE 0 END) as accepted_count
    FROM recommendations
    WHERE action = 'accepted'
    GROUP BY item_id, recommendation_type
    ORDER BY accepted_count DESC
    LIMIT 10
  `).all() as TopItemRow[];

  const topAcceptedItems = topItems.map(row => ({
    itemId: row.item_id,
    itemSlug: row.item_slug,
    itemName: row.item_name,
    type: row.type,
    acceptedCount: row.accepted_count,
  }));

  const totalActioned = overall.accepted + overall.rejected;
  const acceptanceRate = totalActioned > 0 ? overall.accepted / totalActioned : 0;

  return {
    totalRecommendations: overall.total,
    acceptedCount: overall.accepted,
    rejectedCount: overall.rejected,
    ignoredCount: overall.ignored,
    pendingCount: overall.pending,
    acceptanceRate,
    byType,
    bySource,
    topAcceptedItems,
  };
}

/**
 * Get success rate for a specific item
 */
export function getItemSuccessRate(
  itemId: number,
  type: RecommendationType
): ItemSuccessRate | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      item_id, item_slug, item_name, recommendation_type as type,
      COUNT(*) as total,
      SUM(CASE WHEN action = 'accepted' THEN 1 ELSE 0 END) as accepted
    FROM recommendations
    WHERE item_id = ? AND recommendation_type = ?
    GROUP BY item_id
  `).get(itemId, type) as ItemSuccessRow | undefined;

  if (!row) return null;

  const totalActioned = row.total - (row.total - row.accepted);
  return {
    itemId: row.item_id,
    itemSlug: row.item_slug,
    itemName: row.item_name,
    type: row.type,
    totalRecommendations: row.total,
    acceptedCount: row.accepted,
    successRate: totalActioned > 0 ? row.accepted / row.total : 0,
  };
}

/**
 * Get items with highest historical success rates
 */
export function getTopPerformingItems(
  type?: RecommendationType,
  minRecommendations: number = 3,
  limit: number = 20
): ItemSuccessRate[] {
  const db = getDatabase();

  let query = `
    SELECT
      item_id, item_slug, item_name, recommendation_type as type,
      COUNT(*) as total,
      SUM(CASE WHEN action = 'accepted' THEN 1 ELSE 0 END) as accepted
    FROM recommendations
  `;

  const params: (string | number)[] = [];
  if (type) {
    query += ' WHERE recommendation_type = ?';
    params.push(type);
  }

  query += `
    GROUP BY item_id, recommendation_type
    HAVING total >= ?
    ORDER BY (CAST(accepted AS REAL) / total) DESC, accepted DESC
    LIMIT ?
  `;
  params.push(minRecommendations, limit);

  const rows = db.prepare(query).all(...params) as ItemSuccessRow[];

  return rows.map(row => ({
    itemId: row.item_id,
    itemSlug: row.item_slug,
    itemName: row.item_name,
    type: row.type,
    totalRecommendations: row.total,
    acceptedCount: row.accepted,
    successRate: row.total > 0 ? row.accepted / row.total : 0,
  }));
}

/**
 * Check if an item was recently recommended to avoid duplicates
 */
export function wasRecentlyRecommended(
  itemId: number,
  type: RecommendationType,
  sessionId: string | null,
  withinMinutes: number = 10
): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM recommendations
    WHERE item_id = ? AND recommendation_type = ?
    AND (session_id = ? OR ? IS NULL)
    AND datetime(created_at) > datetime('now', ?)
  `).get(itemId, type, sessionId, sessionId, `-${withinMinutes} minutes`) as { count: number };
  return result.count > 0;
}

/**
 * Cleanup old recommendation records
 */
export function cleanupOldRecommendations(maxAgeDays: number = 90): number {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM recommendations
    WHERE datetime(created_at) < datetime('now', ?)
  `).run(`-${maxAgeDays} days`);
  return result.changes;
}

// ============================================================================
// MAPPER
// ============================================================================

function mapRowToRecommendation(row: RecommendationRow): RecommendationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    recommendationType: row.recommendation_type,
    itemId: row.item_id,
    itemSlug: row.item_slug,
    itemName: row.item_name,
    confidenceScore: row.confidence_score,
    source: row.source,
    matchedKeywords: row.matched_keywords,
    promptSnippet: row.prompt_snippet,
    action: row.action,
    actionTimestamp: row.action_timestamp,
    createdAt: row.created_at,
  };
}
