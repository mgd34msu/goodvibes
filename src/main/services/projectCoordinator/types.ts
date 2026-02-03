// ============================================================================
// PROJECT COORDINATOR - Type definitions
// ============================================================================

/**
 * Agent working across projects
 */
export interface CrossProjectAgent {
  agentId: number;
  agentName: string;
  projectIds: number[];
  currentProjectId: number | null;
  status: 'idle' | 'active' | 'transitioning';
  lastActivity: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Shared skill configuration
 */
export interface SharedSkillConfig {
  skillId: number;
  skillName: string;
  sharedAcross: number[]; // project IDs
  settings: Record<string, unknown>;
  enabled: boolean;
  lastModified: Date;
}

/**
 * Project state for synchronization
 */
export interface ProjectState {
  projectId: number;
  projectPath: string;
  activeAgents: number[];
  pendingSkills: number[];
  sessionId: string | null;
  lastSync: Date;
  version: number;
}

/**
 * Project event
 */
export interface ProjectEvent {
  id: string;
  type: string;
  sourceProjectId: number | null;
  targetProjectIds: number[];
  data: Record<string, unknown>;
  timestamp: Date;
  handled: boolean;
}

/**
 * Coordination status
 */
export interface CoordinationStatus {
  initialized: boolean;
  crossProjectAgentCount: number;
  sharedSkillCount: number;
  pendingEventCount: number;
  activeProjects: number[];
}

/**
 * Agent status type
 */
export type AgentStatus = 'idle' | 'active' | 'transitioning';
