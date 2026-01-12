// ============================================================================
// AGENCY INDEX DATABASE - Active Agent and Queued Skill Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  ActiveAgent,
  ActiveAgentRow,
  QueuedSkill,
  QueuedSkillRow,
} from './types.js';

// ============================================================================
// ACTIVE AGENT OPERATIONS
// ============================================================================

export function activateAgent(agentId: number, sessionId?: string, projectPath?: string, priority: number = 0): ActiveAgent {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO active_agents (session_id, project_path, agent_id, priority)
    VALUES (?, ?, ?, ?)
  `).run(sessionId || null, projectPath || null, agentId, priority);

  const inserted = getActiveAgent(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve activated agent with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

export function getActiveAgent(id: number): ActiveAgent | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM active_agents WHERE id = ?').get(id) as ActiveAgentRow | undefined;
  return row ? mapRowToActiveAgent(row) : null;
}

export function getActiveAgentsForSession(sessionId: string): ActiveAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM active_agents
    WHERE (session_id = ? OR session_id IS NULL) AND is_active = 1
    ORDER BY priority DESC
  `).all(sessionId) as ActiveAgentRow[];
  return rows.map(mapRowToActiveAgent);
}

export function getActiveAgentsForProject(projectPath: string): ActiveAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM active_agents
    WHERE (project_path = ? OR project_path IS NULL) AND is_active = 1
    ORDER BY priority DESC
  `).all(projectPath) as ActiveAgentRow[];
  return rows.map(mapRowToActiveAgent);
}

export function getAllActiveAgentConfigs(): ActiveAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM active_agents
    WHERE is_active = 1
    ORDER BY priority DESC
  `).all() as ActiveAgentRow[];
  return rows.map(mapRowToActiveAgent);
}

export function deactivateAgent(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE active_agents SET
      is_active = 0,
      deactivated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function deactivateAgentByAgentId(agentId: number, sessionId?: string, projectPath?: string): void {
  const db = getDatabase();

  let query = 'UPDATE active_agents SET is_active = 0, deactivated_at = datetime(\'now\') WHERE agent_id = ?';
  const params: (number | string | null)[] = [agentId];

  if (sessionId !== undefined) {
    query += ' AND (session_id = ? OR session_id IS NULL)';
    params.push(sessionId || null);
  }

  if (projectPath !== undefined) {
    query += ' AND (project_path = ? OR project_path IS NULL)';
    params.push(projectPath || null);
  }

  db.prepare(query).run(...params);
}

function mapRowToActiveAgent(row: ActiveAgentRow): ActiveAgent {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    agentId: row.agent_id,
    priority: row.priority,
    activatedAt: row.activated_at,
    deactivatedAt: row.deactivated_at,
    isActive: row.is_active === 1,
  };
}

// ============================================================================
// QUEUED SKILL OPERATIONS
// ============================================================================

export function queueSkill(skillId: number, sessionId?: string, projectPath?: string, priority: number = 0): QueuedSkill {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO queued_skills (session_id, project_path, skill_id, priority)
    VALUES (?, ?, ?, ?)
  `).run(sessionId || null, projectPath || null, skillId, priority);

  const inserted = getQueuedSkill(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve queued skill with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

export function getQueuedSkill(id: number): QueuedSkill | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM queued_skills WHERE id = ?').get(id) as QueuedSkillRow | undefined;
  return row ? mapRowToQueuedSkill(row) : null;
}

export function getPendingSkillsForSession(sessionId: string): QueuedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM queued_skills
    WHERE (session_id = ? OR session_id IS NULL) AND injected = 0
    ORDER BY priority DESC, queued_at ASC
  `).all(sessionId) as QueuedSkillRow[];
  return rows.map(mapRowToQueuedSkill);
}

export function getPendingSkillsForProject(projectPath: string): QueuedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM queued_skills
    WHERE (project_path = ? OR project_path IS NULL) AND injected = 0
    ORDER BY priority DESC, queued_at ASC
  `).all(projectPath) as QueuedSkillRow[];
  return rows.map(mapRowToQueuedSkill);
}

export function getAllPendingSkills(): QueuedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM queued_skills
    WHERE injected = 0
    ORDER BY priority DESC, queued_at ASC
  `).all() as QueuedSkillRow[];
  return rows.map(mapRowToQueuedSkill);
}

export function markSkillInjected(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE queued_skills SET
      injected = 1,
      injected_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function removeQueuedSkill(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM queued_skills WHERE id = ?').run(id);
}

export function clearSkillQueue(sessionId?: string, projectPath?: string): void {
  const db = getDatabase();

  let query = 'DELETE FROM queued_skills WHERE 1=1';
  const params: (string | null)[] = [];

  if (sessionId !== undefined) {
    query += ' AND (session_id = ? OR session_id IS NULL)';
    params.push(sessionId || null);
  }

  if (projectPath !== undefined) {
    query += ' AND (project_path = ? OR project_path IS NULL)';
    params.push(projectPath || null);
  }

  db.prepare(query).run(...params);
}

function mapRowToQueuedSkill(row: QueuedSkillRow): QueuedSkill {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    skillId: row.skill_id,
    priority: row.priority,
    injected: row.injected === 1,
    injectedAt: row.injected_at,
    queuedAt: row.queued_at,
  };
}
