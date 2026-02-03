// ============================================================================
// PROJECT REGISTRY DATABASE - Analytics Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';
import type {
  ProjectAnalytics,
  GlobalAnalytics,
  AnalyticsStatsRow,
  ProjectAnalyticsRow,
  ProjectDistributionRow,
  RecentActivityRow,
  AgentUsageRow,
  SessionDistributionRow,
  GlobalStatsRow,
} from './types.js';
import { getRegisteredProject } from './projects.js';

const logger = new Logger('ProjectRegistryDB:Analytics');

// ============================================================================
// ANALYTICS OPERATIONS
// ============================================================================

/**
 * Convert a file path to the encoded project_name format used in sessions table.
 * e.g., "C:\Users\buzzkill\Documents\clausitron" -> "C--Users-buzzkill-Documents-clausitron"
 */
function encodeProjectPath(path: string): string {
  return path.replace(/:/g, '-').replace(/[\\/]/g, '-');
}

/**
 * Get analytics for a single project.
 * Queries the main sessions table using the encoded project path.
 */
export function getProjectAnalytics(projectId: number): ProjectAnalytics | null {
  const db = getDatabase();
  const project = getRegisteredProject(projectId);
  if (!project) return null;

  // Convert project path to the encoded format used in sessions.project_name
  const encodedPath = encodeProjectPath(project.path);

  // Query the main sessions table for this project's stats
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(token_count), 0) as total_tokens,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
      COALESCE(SUM(cost), 0) as total_cost,
      COALESCE(AVG(
        CASE WHEN end_time IS NOT NULL AND start_time IS NOT NULL
        THEN (julianday(end_time) - julianday(start_time)) * 86400000
        ELSE NULL END
      ), 0) as avg_duration,
      MAX(end_time) as last_activity,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
    FROM sessions
    WHERE project_name = ?
  `).get(encodedPath) as AnalyticsStatsRow;

  const totalSessions = stats.total_sessions || 0;

  return {
    projectId,
    projectPath: project.path,
    projectName: project.name,
    totalSessions,
    totalTokens: stats.total_tokens || 0,
    inputTokens: stats.input_tokens || 0,
    outputTokens: stats.output_tokens || 0,
    cacheReadTokens: stats.cache_read_tokens || 0,
    cacheWriteTokens: stats.cache_write_tokens || 0,
    totalCostUsd: stats.total_cost || 0,
    avgSessionDuration: stats.avg_duration || 0,
    avgTokensPerSession: totalSessions > 0 ? (stats.total_tokens || 0) / totalSessions : 0,
    avgCostPerSession: totalSessions > 0 ? (stats.total_cost || 0) / totalSessions : 0,
    successRate: totalSessions > 0 ? (stats.completed_count || 0) / totalSessions : 0,
    lastActivity: stats.last_activity,
  };
}

/**
 * Get global analytics across all projects
 */
export function getGlobalAnalytics(): GlobalAnalytics {
  const db = getDatabase();

  // Basic stats
  const globalStats = db.prepare(`
    SELECT
      COUNT(DISTINCT p.id) as total_projects,
      COUNT(DISTINCT CASE WHEN s.status = 'active' THEN p.id END) as active_projects,
      COALESCE(SUM(s.tokens_used), 0) as total_tokens,
      COALESCE(SUM(s.cost_usd), 0) as total_cost,
      COUNT(s.id) as total_sessions
    FROM registered_projects p
    LEFT JOIN cross_project_sessions s ON p.id = s.project_id
  `).get() as GlobalStatsRow;

  const totalProjects = globalStats.total_projects || 0;

  // Top projects by cost
  const topByCost = db.prepare(`
    SELECT
      p.id as project_id,
      p.path as project_path,
      p.name as project_name,
      COUNT(s.id) as total_sessions,
      COALESCE(SUM(s.tokens_used), 0) as total_tokens,
      COALESCE(SUM(s.cost_usd), 0) as total_cost,
      MAX(s.started_at) as last_activity
    FROM registered_projects p
    LEFT JOIN cross_project_sessions s ON p.id = s.project_id
    GROUP BY p.id
    ORDER BY total_cost DESC
    LIMIT 10
  `).all() as ProjectAnalyticsRow[];

  // Top projects by sessions
  const topBySessions = db.prepare(`
    SELECT
      p.id as project_id,
      p.path as project_path,
      p.name as project_name,
      COUNT(s.id) as total_sessions,
      COALESCE(SUM(s.tokens_used), 0) as total_tokens,
      COALESCE(SUM(s.cost_usd), 0) as total_cost,
      MAX(s.started_at) as last_activity
    FROM registered_projects p
    LEFT JOIN cross_project_sessions s ON p.id = s.project_id
    GROUP BY p.id
    ORDER BY total_sessions DESC
    LIMIT 10
  `).all() as ProjectAnalyticsRow[];

  // Project distribution
  const distribution = db.prepare(`
    SELECT
      p.id as project_id,
      p.name as project_name,
      COALESCE(SUM(s.cost_usd), 0) as cost
    FROM registered_projects p
    LEFT JOIN cross_project_sessions s ON p.id = s.project_id
    GROUP BY p.id
    HAVING cost > 0
  `).all() as ProjectDistributionRow[];

  const totalCost = globalStats.total_cost || 1; // Avoid division by zero
  const projectDistribution = distribution.map(d => ({
    projectId: d.project_id,
    projectName: d.project_name,
    percentage: (d.cost / totalCost) * 100,
  }));

  // Recent activity
  const recentActivity = db.prepare(`
    SELECT
      p.id as project_id,
      p.name as project_name,
      MAX(s.started_at) as last_activity
    FROM registered_projects p
    JOIN cross_project_sessions s ON p.id = s.project_id
    GROUP BY p.id
    ORDER BY last_activity DESC
    LIMIT 10
  `).all() as RecentActivityRow[];

  const mapToProjectAnalytics = (row: ProjectAnalyticsRow): ProjectAnalytics => {
    const sessions = row.total_sessions || 0;
    return {
      projectId: row.project_id,
      projectPath: row.project_path,
      projectName: row.project_name,
      totalSessions: sessions,
      totalTokens: row.total_tokens || 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: row.total_cost || 0,
      avgSessionDuration: 0,
      avgTokensPerSession: sessions > 0 ? (row.total_tokens || 0) / sessions : 0,
      avgCostPerSession: sessions > 0 ? (row.total_cost || 0) / sessions : 0,
      successRate: 0,
      lastActivity: row.last_activity,
    };
  };

  return {
    totalProjects,
    activeProjects: globalStats.active_projects || 0,
    totalSessions: globalStats.total_sessions || 0,
    totalTokens: globalStats.total_tokens || 0,
    totalCostUsd: globalStats.total_cost || 0,
    avgCostPerProject: totalProjects > 0 ? (globalStats.total_cost || 0) / totalProjects : 0,
    avgSessionsPerProject: totalProjects > 0 ? (globalStats.total_sessions || 0) / totalProjects : 0,
    topProjectsByCost: topByCost.map(mapToProjectAnalytics),
    topProjectsBySessions: topBySessions.map(mapToProjectAnalytics),
    projectDistribution,
    recentActivity: recentActivity.map(r => ({
      projectId: r.project_id,
      projectName: r.project_name,
      lastActivity: r.last_activity,
    })),
  };
}

/**
 * Get agent usage across projects
 */
export function getAgentUsageByProject(): { agentId: number; projectId: number; projectName: string; sessionCount: number; totalCost: number }[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      pa.agent_id,
      p.id as project_id,
      p.name as project_name,
      COUNT(s.id) as session_count,
      COALESCE(SUM(s.cost_usd), 0) as total_cost
    FROM project_agents pa
    JOIN registered_projects p ON pa.project_id = p.id
    LEFT JOIN cross_project_sessions s ON p.id = s.project_id
    GROUP BY pa.agent_id, p.id
    ORDER BY session_count DESC
  `).all() as AgentUsageRow[];

  return rows.map(row => ({
    agentId: row.agent_id,
    projectId: row.project_id,
    projectName: row.project_name,
    sessionCount: row.session_count || 0,
    totalCost: row.total_cost || 0,
  }));
}

/**
 * Get session distribution by project
 */
export function getSessionDistribution(): { projectId: number; projectName: string; sessionCount: number; percentage: number }[] {
  const db = getDatabase();

  const total = db.prepare('SELECT COUNT(*) as count FROM cross_project_sessions').get() as { count: number };
  const totalSessions = total.count || 1;

  const rows = db.prepare(`
    SELECT
      p.id as project_id,
      p.name as project_name,
      COUNT(s.id) as session_count
    FROM registered_projects p
    LEFT JOIN cross_project_sessions s ON p.id = s.project_id
    GROUP BY p.id
    ORDER BY session_count DESC
  `).all() as SessionDistributionRow[];

  return rows.map(row => ({
    projectId: row.project_id,
    projectName: row.project_name,
    sessionCount: row.session_count || 0,
    percentage: ((row.session_count || 0) / totalSessions) * 100,
  }));
}

/**
 * Get project comparison metrics
 */
export function compareProjects(projectIds: number[]): ProjectAnalytics[] {
  return projectIds
    .map(id => getProjectAnalytics(id))
    .filter((a): a is ProjectAnalytics => a !== null);
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up old session records
 */
export function cleanupOldSessions(maxAgeDays: number = 90): number {
  const db = getDatabase();
  const threshold = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM cross_project_sessions
    WHERE ended_at IS NOT NULL AND ended_at < ?
  `).run(threshold);

  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} old cross-project session records`);
  }

  return result.changes;
}
