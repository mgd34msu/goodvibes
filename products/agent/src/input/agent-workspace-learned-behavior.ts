import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
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

/**
 * Runs the second write of a two-write save (an edited skill or routine, then its enabled
 * flag; their registries' update takes no enabled value yet). When the second write fails the
 * edit is already on disk; the error says so, which stops a retry from repeating it.
 */
export function runFollowUpWrite(saved: string, followUp: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${saved} was saved, but ${followUp} failed: ${reason}. Open it from the list to finish; do not create it again.`, { cause: error });
  }
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
