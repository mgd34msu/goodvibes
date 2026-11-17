import { buildAgentSkillRequirements, type AgentSkillRequirement } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { splitList } from './agent-workspace-editors.ts';

export type AgentWorkspaceEditorFieldReader = (fieldId: string) => string;

export function buildAgentWorkspaceRequirements(readField: AgentWorkspaceEditorFieldReader): readonly AgentSkillRequirement[] {
  return buildAgentSkillRequirements({
    env: splitList(readField('requiresEnv')),
    commands: splitList(readField('requiresCommands')),
  });
}
