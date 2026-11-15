import { toJson, fanOut, type EntryType } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/index.js';
import { archetypeLoaderFor, type AgentArchetype } from './archetypes.js';
import { archetypeFamilyAt, type ArchetypeFamily } from './batteries/archetype-family.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';

export type { ArchetypeFamily } from './batteries/archetype-family.js';

/**
 * The archetypes in an agents directory, read once through the process's
 * loader for it (the same one spawns use), with each custom file's prompt
 * text so a reading of its purpose sees what the agent would be told.
 */
export function readArchetypeListing(directory: string): AgentArchetype[] {
  return archetypeLoaderFor(directory).listArchetypes({ withPrompts: true });
}

export type ArchetypeFamilyReading =
  | { readonly kind: 'unclassified'; readonly provenance: 'classic' }
  | { readonly kind: 'settled'; readonly family: ArchetypeFamily }
  | { readonly kind: 'held' };

/** All entries share one request. Nothing guesses a family the reading did not settle. */
export async function readArchetypeFamilies(
  archetypes: readonly AgentArchetype[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<{ readonly readings: readonly ArchetypeFamilyReading[] }> {
  return decisionOrClassic(
    () => readDecisionArchetypeFamilies(archetypes, options.signal),
    () => {
      options.signal?.throwIfAborted();
      return { readings: archetypes.map((): ArchetypeFamilyReading => ({ kind: 'unclassified', provenance: 'classic' })) };
    },
  );
}

async function readDecisionArchetypeFamilies(archetypes: readonly AgentArchetype[], signal: AbortSignal | undefined) {
  signal?.throwIfAborted();
  // Only entries a spawn could use are read; a file that cannot be used has no purpose to classify.
  const evidence = archetypes.map((archetype) => ({
    name: archetype.name, description: archetype.description, tools: archetype.tools,
    ...(archetype.systemPrompt === undefined ? {} : { systemPrompt: archetype.systemPrompt }),
  }));
  assertJudgmentInput(evidence);
  const usable = archetypes.map((archetype) => archetype.usable !== false);
  if (!usable.some(Boolean)) return { readings: archetypes.map((): ArchetypeFamilyReading => ({ kind: 'held' })) };
  const parts: Record<string, ReturnType<typeof archetypeFamilyAt>> = {};
  evidence.forEach((_, index) => { if (usable[index]) parts[`archetype${index}`] = archetypeFamilyAt(index); });
  const site = 'agents.archetype-family';
  const result = await fanOut(judgmentPort(site), toJson({ archetypes: evidence }) as EntryType, parts, {
    ...(signal === undefined ? {} : { signal }), site, label: 'engine.agents.archetype-family',
  });
  const readings = evidence.map((_, index): ArchetypeFamilyReading => {
    const reading = result.readings[`archetype${index}`]?.family;
    return reading?.outcome === 'act' && reading.choice !== 'unknown'
      ? { kind: 'settled', family: reading.choice } : { kind: 'held' };
  });
  result.recordAction('observe archetype listing families');
  return { readings };
}
