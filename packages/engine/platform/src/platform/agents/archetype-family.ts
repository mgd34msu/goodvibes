import { archetypeLoaderFor, type AgentArchetype } from './archetypes.js';
import { ARCHETYPE_FAMILIES, type ArchetypeFamily } from './batteries/archetype-family.js';

export type { ArchetypeFamily } from './batteries/archetype-family.js';

/**
 * The archetypes in an agents directory, read once through the process's
 * loader for it (the same one spawns use). A listing is a point-in-time
 * answer: nothing re-reads the directory to prove it did not change.
 */
export function readArchetypeListing(directory: string): AgentArchetype[] {
  return archetypeLoaderFor(directory).listArchetypes();
}

/** The family each built-in template does its work in. */
const BUILTIN_FAMILIES: Readonly<Record<string, ArchetypeFamily>> = {
  orchestrator: 'general',
  planner: 'research',
  engineer: 'implement',
  reviewer: 'review',
  tester: 'test',
  researcher: 'research',
  integrator: 'implement',
  general: 'general',
};

/** The families an archetype file may declare in its `family:` front matter field. */
export const DECLARABLE_ARCHETYPE_FAMILIES: readonly ArchetypeFamily[] =
  (Object.keys(ARCHETYPE_FAMILIES) as (keyof typeof ARCHETYPE_FAMILIES)[]).filter((family): family is ArchetypeFamily => family !== 'unknown');

export type ArchetypeFamilyReading =
  | { readonly kind: 'settled'; readonly family: ArchetypeFamily; readonly source: 'builtin' | 'declared' }
  | { readonly kind: 'undeclared'; readonly reason: string };

/**
 * An archetype's family, a fact of the archetype: a built-in template's own,
 * or the `family:` field a custom file declares. No model reads its prose, so
 * every decision policy gives the same answer.
 */
export function archetypeFamilyOf(archetype: Pick<AgentArchetype, 'name' | 'isCustom' | 'family'>): ArchetypeFamilyReading {
  if (!archetype.isCustom) {
    const family = BUILTIN_FAMILIES[archetype.name];
    return family ? { kind: 'settled', family, source: 'builtin' } : { kind: 'undeclared', reason: `built-in archetype ${archetype.name} has no family` };
  }
  const declared = archetype.family?.trim().toLowerCase();
  if (!declared) {
    return { kind: 'undeclared', reason: `add "family: <${DECLARABLE_ARCHETYPE_FAMILIES.join('|')}>" to its front matter` };
  }
  const family = DECLARABLE_ARCHETYPE_FAMILIES.find((candidate) => candidate === declared);
  return family
    ? { kind: 'settled', family, source: 'declared' }
    : { kind: 'undeclared', reason: `its family "${declared}" is not one of ${DECLARABLE_ARCHETYPE_FAMILIES.join(', ')}` };
}
