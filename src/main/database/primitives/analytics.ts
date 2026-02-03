// ============================================================================
// DATABASE PRIMITIVES - Analytics Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  SessionAnalytics,
  SessionAnalyticsRow,
  DetailedToolUsage,
  ToolUsageDetailedRow,
  ToolEfficiencyRow,
  ToolCostBreakdown,
} from './types.js';

// ============================================================================
// SESSION ANALYTICS OPERATIONS
// ============================================================================

export function upsertSessionAnalytics(analytics: Partial<SessionAnalytics> & { sessionId: string }): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO session_analytics (
      session_id, success_score, iteration_count, tool_efficiency,
      context_usage_peak, estimated_roi, tags_auto, outcome_analysis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      success_score = COALESCE(excluded.success_score, success_score),
      iteration_count = COALESCE(excluded.iteration_count, iteration_count),
      tool_efficiency = COALESCE(excluded.tool_efficiency, tool_efficiency),
      context_usage_peak = COALESCE(excluded.context_usage_peak, context_usage_peak),
      estimated_roi = COALESCE(excluded.estimated_roi, estimated_roi),
      tags_auto = COALESCE(excluded.tags_auto, tags_auto),
      outcome_analysis = COALESCE(excluded.outcome_analysis, outcome_analysis),
      updated_at = datetime('now')
  `).run(
    analytics.sessionId,
    analytics.successScore ?? null,
    analytics.iterationCount ?? 0,
    analytics.toolEfficiency ?? null,
    analytics.contextUsagePeak ?? null,
    analytics.estimatedRoi ?? null,
    JSON.stringify(analytics.tagsAuto || []),
    analytics.outcomeAnalysis ?? null
  );
}

export function getSessionAnalytics(sessionId: string): SessionAnalytics | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM session_analytics WHERE session_id = ?').get(sessionId) as SessionAnalyticsRow | undefined;

  if (!row) return null;

  return {
    sessionId: row.session_id,
    successScore: row.success_score,
    iterationCount: row.iteration_count,
    toolEfficiency: row.tool_efficiency,
    contextUsagePeak: row.context_usage_peak,
    estimatedRoi: row.estimated_roi,
    tagsAuto: JSON.parse(row.tags_auto ?? '[]'),
    outcomeAnalysis: row.outcome_analysis,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// DETAILED TOOL USAGE OPERATIONS
// ============================================================================

export function recordDetailedToolUsage(usage: {
  sessionId: string | null;
  toolName: string;
  toolInput: string | null;
  toolResultPreview: string | null;
  success: boolean;
  durationMs: number | null;
  tokenCost: number | null;
}): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO tool_usage_detailed (
      session_id, tool_name, tool_input, tool_result_preview,
      success, duration_ms, token_cost,
      input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
      cost_usd, entry_hash, tool_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    usage.sessionId,
    usage.toolName,
    usage.toolInput,
    usage.toolResultPreview,
    usage.success ? 1 : 0,
    usage.durationMs,
    usage.tokenCost,
    0, // input_tokens
    0, // output_tokens
    0, // cache_write_tokens
    0, // cache_read_tokens
    0, // cost_usd
    '', // entry_hash - empty for legacy entries
    0  // tool_index
  );
}

export function getDetailedToolUsageBySession(sessionId: string): DetailedToolUsage[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM tool_usage_detailed
    WHERE session_id = ?
    ORDER BY timestamp
  `).all(sessionId) as any[];

  return rows.map(row => ({
    sessionId: row.session_id || '',
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolResultPreview: row.tool_result_preview,
    success: row.success === 1,
    durationMs: row.duration_ms,
    tokenCost: row.token_cost || 0,
    timestamp: row.timestamp,
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    cacheWriteTokens: row.cache_write_tokens || 0,
    cacheReadTokens: row.cache_read_tokens || 0,
    costUsd: row.cost_usd || 0,
    messageId: row.message_id,
    requestId: row.request_id,
    entryHash: row.entry_hash || '',
    toolIndex: row.tool_index || 0,
    model: row.model,
  }));
}

export function getToolEfficiencyStats(): Array<{
  toolName: string;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number | null;
  totalTokenCost: number;
}> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) as total_calls,
      AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
      AVG(duration_ms) as avg_duration,
      SUM(COALESCE(token_cost, 0)) as total_tokens
    FROM tool_usage_detailed
    GROUP BY tool_name
    ORDER BY total_calls DESC
  `).all() as ToolEfficiencyRow[];

  return rows.map(row => ({
    toolName: row.tool_name,
    totalCalls: row.total_calls,
    successRate: row.success_rate,
    avgDurationMs: row.avg_duration,
    totalTokenCost: row.total_tokens,
  }));
}

/**
 * Clear all detailed tool usage for a session (for re-parsing)
 */
export function clearDetailedToolUsage(sessionId: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM tool_usage_detailed WHERE session_id = ?').run(sessionId);
}

/**
 * Batch insert detailed tool usage entries
 * Uses INSERT OR REPLACE for upsert behavior on entry_hash
 */
export function batchRecordDetailedToolUsage(usages: DetailedToolUsage[]): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tool_usage_detailed (
      session_id, tool_name, tool_input, tool_result_preview,
      success, duration_ms, token_cost, timestamp,
      input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
      cost_usd, message_id, request_id, entry_hash, tool_index, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((items: DetailedToolUsage[]) => {
    for (const u of items) {
      stmt.run(
        u.sessionId, u.toolName, u.toolInput, u.toolResultPreview,
        u.success ? 1 : 0, u.durationMs, u.tokenCost, u.timestamp,
        u.inputTokens, u.outputTokens, u.cacheWriteTokens, u.cacheReadTokens,
        u.costUsd, u.messageId, u.requestId, u.entryHash, u.toolIndex, u.model
      );
    }
  });
  
  insertMany(usages);
}

/**
 * Get aggregated tool cost breakdown for a session
 */
export function getSessionToolCostBreakdown(sessionId: string): ToolCostBreakdown[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT 
      tool_name as toolName,
      COUNT(*) as callCount,
      SUM(input_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(cache_write_tokens) as cacheWriteTokens,
      SUM(cache_read_tokens) as cacheReadTokens,
      SUM(cost_usd) as totalCost,
      AVG(cost_usd) as avgCostPerCall,
      AVG(duration_ms) as avgDurationMs
    FROM tool_usage_detailed
    WHERE session_id = ?
    GROUP BY tool_name
    ORDER BY SUM(cost_usd) DESC
  `).all(sessionId) as ToolCostBreakdown[];
}
