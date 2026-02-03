// ============================================================================
// AGENTS VIEW - TYPE DEFINITIONS
// ============================================================================

export interface AgentTemplate {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  initialPrompt: string | null;
  claudeMdContent: string | null;
  flags: string[];
  model: string | null;
  permissionMode: 'default' | 'plan' | 'bypassPermissions' | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export type BuiltInAgent = Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>;

export type AgentCardAgent = AgentTemplate | (BuiltInAgent & { isBuiltIn: true });
