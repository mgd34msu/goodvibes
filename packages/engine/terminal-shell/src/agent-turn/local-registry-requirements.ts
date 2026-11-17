import type { AgentSkillRequirement } from './skill-registry.js';

function readList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * `existing` is the record being updated: a kind the caller did not mention
 * keeps its current entries instead of being replaced by an empty list.
 */
export function buildAgentLocalRequirements(
  requiresEnv: unknown,
  requiresCommands: unknown,
  existing: readonly AgentSkillRequirement[] = [],
): readonly AgentSkillRequirement[] | undefined {
  if (requiresEnv === undefined && requiresCommands === undefined) return undefined;
  const envs = requiresEnv === undefined
    ? existing.filter((entry) => entry.kind === 'env')
    : readList(requiresEnv).map((name) => ({ kind: 'env' as const, name }));
  const commands = requiresCommands === undefined
    ? existing.filter((entry) => entry.kind === 'command')
    : readList(requiresCommands).map((name) => ({ kind: 'command' as const, name }));
  return [...envs, ...commands];
}
