// ============================================================================
// PROJECT REGISTRY - Type definitions
// ============================================================================

/**
 * Project context for runtime state management
 */
export interface ProjectContext {
  projectId: number;
  projectPath: string;
  activeSessionId: string | null;
  activatedAgents: number[];
  injectedSkills: number[];
  lastActivity: Date;
}

// Re-export types from database module
export type {
  RegisteredProject,
  ProjectSettings,
  ProjectAgent,
  ProjectAgentSettings,
  ProjectTemplate,
  TemplateAgent,
  CrossProjectSession,
  ProjectAnalytics,
  GlobalAnalytics,
} from '../../database/projectRegistry.js';
