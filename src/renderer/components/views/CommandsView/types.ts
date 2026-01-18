// ============================================================================
// COMMANDS VIEW - TYPE DEFINITIONS
// ============================================================================

export interface Command {
  id: number;
  name: string;
  description: string | null;
  content: string;
  allowedTools: string[] | null;
  scope: 'user' | 'project';
  projectPath: string | null;
  useCount: number;
  lastUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BuiltInCommand = Omit<Command, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>;

export type CommandCardCommand = Command | (BuiltInCommand & { isBuiltIn: true });
