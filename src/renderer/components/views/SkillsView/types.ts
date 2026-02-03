// ============================================================================
// AGENT SKILLS VIEW - TYPE DEFINITIONS (Agent-callable Skills)
// ============================================================================

/**
 * Agent Skill - A skill that can be invoked by agents programmatically
 * via the Skill tool (e.g., Skill skill: "code-review").
 *
 * Unlike slash commands which users invoke directly, agent skills are
 * designed for agent-to-agent communication and automated workflows.
 */
export interface AgentSkill {
  id: number;
  name: string; // lowercase, hyphens, max 64 chars
  description: string;
  content: string; // SKILL.md content with frontmatter
  allowedTools: string[] | null;
  scope: 'user' | 'project';
  projectPath: string | null;
  version: string | null;
  useCount: number;
  lastUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Built-in agent skill without database-specific fields
 */
export type BuiltInAgentSkill = Omit<
  AgentSkill,
  'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'
>;

/**
 * Union type for skill cards - can be either a saved skill or a built-in one
 */
export type SkillCardSkill = AgentSkill | (BuiltInAgentSkill & { isBuiltIn: true });
