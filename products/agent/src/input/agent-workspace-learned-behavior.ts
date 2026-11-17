import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/persona-registry';
import { AgentRoutineRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/routine-registry';
import { AgentSkillRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry';
import type { AgentWorkspaceLocalEditorKind } from './agent-workspace-types.ts';

export interface AgentWorkspaceLearnedBehaviorInput {
  readonly target: Exclude<AgentWorkspaceLocalEditorKind, 'memory' | 'note' | 'profile'>;
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly tags: readonly string[];
  readonly triggers: readonly string[];
  readonly enable: boolean;
}

export interface AgentWorkspaceLearnedBehaviorResult {
  readonly kind: Exclude<AgentWorkspaceLocalEditorKind, 'memory' | 'note' | 'profile'>;
  readonly id: string;
  readonly name: string;
}

export function createAgentWorkspaceLearnedBehavior(
  shellPaths: ShellPathService,
  input: AgentWorkspaceLearnedBehaviorInput,
  assertCurrent?: () => void,
): AgentWorkspaceLearnedBehaviorResult {
  if (input.target === 'persona') {
    const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    assertCurrent?.();
    // Saved and made active in one write: nothing can leave it saved but not active.
    const created = registry.create({
      name: input.name,
      description: input.description,
      body: input.notes,
      tags: input.tags,
      triggers: input.triggers,
      source: 'agent',
      provenance: 'agent-workspace-learned-behavior',
      active: input.enable,
    });
    return { kind: 'persona', id: created.id, name: created.name };
  }

  if (input.target === 'skill') {
    assertCurrent?.();
    const created = AgentSkillRegistry.fromShellPaths(shellPaths).create({
      name: input.name,
      description: input.description,
      procedure: input.notes,
      tags: input.tags,
      triggers: input.triggers,
      enabled: input.enable,
      source: 'agent',
      provenance: 'agent-workspace-learned-behavior',
    });
    return { kind: 'skill', id: created.id, name: created.name };
  }

  assertCurrent?.();
  const created = AgentRoutineRegistry.fromShellPaths(shellPaths).create({
    name: input.name,
    description: input.description,
    steps: input.notes,
    tags: input.tags,
    triggers: input.triggers,
    enabled: input.enable,
    source: 'agent',
    provenance: 'agent-workspace-learned-behavior',
  });
  return { kind: 'routine', id: created.id, name: created.name };
}
