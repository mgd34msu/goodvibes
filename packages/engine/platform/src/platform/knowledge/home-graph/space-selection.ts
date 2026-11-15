import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeStore } from '../store.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { homeAssistantSpaceComponent, resolveHomeGraphSpace, sameHomeAssistantSpace } from './helpers.js';
import type { HomeGraphSpaceInput } from './types.js';

/**
 * The one rule every Home Graph verb uses to pick a space.
 * Explicit ids select that Home Assistant space (matching a stored spelling
 * when one exists). With no ids the default space wins when it has records,
 * a lone Home Assistant space is used as is, and several spaces without a
 * default are an error that names them: a verb must never guess among them.
 */
export function resolveReadableHomeGraphSpace(
  store: KnowledgeStore,
  input: HomeGraphSpaceInput = {},
): {
  readonly spaceId: string;
  readonly installationId: string;
} {
  const resolved = resolveHomeGraphSpace(input);
  const candidates = listHomeGraphSpaces(store);
  const pick = (spaceId: string | undefined) => spaceId === undefined ? resolved : {
    spaceId,
    installationId: homeAssistantSpaceComponent(spaceId) ?? resolved.installationId,
  };
  const matching = candidates.filter((spaceId) => sameHomeAssistantSpace(spaceId, resolved.spaceId));
  if (hasExplicitSpace(input) || matching.length > 0) return pick(matching[0]);
  if (candidates.length === 0) return resolved;
  if (candidates.length === 1) return pick(candidates[0]);
  throw ambiguousSpaceError(candidates);
}

/**
 * Same rule as the readable resolver, but a write that names its space goes
 * straight to it: listing every record first is only needed to guess a space
 * for a request that named none.
 */
export function resolveWritableHomeGraphSpace(
  store: KnowledgeStore,
  input: HomeGraphSpaceInput = {},
): { readonly spaceId: string; readonly installationId: string } {
  return hasExplicitSpace(input) ? resolveHomeGraphSpace(input) : resolveReadableHomeGraphSpace(store, input);
}

/**
 * Resolves the target of a destructive reset. A reset that names no space is
 * only allowed as a dry run, so the preview reports the space before anything
 * is deleted.
 */
export function resolveHomeGraphResetSpace(
  store: KnowledgeStore,
  input: HomeGraphSpaceInput & { readonly dryRun?: boolean | undefined } = {},
): { readonly spaceId: string; readonly installationId: string } {
  if (input.dryRun !== true && !hasExplicitSpace(input)) {
    const known = listHomeGraphSpaces(store);
    throw new GoodVibesError(
      `Home Graph reset needs installationId or knowledgeSpaceId so the target is never guessed${known.length ? `; Home Assistant spaces present: ${known.join(', ')}` : ''}. Pass dryRun: true to preview.`,
      { category: 'bad_request', source: 'runtime', operation: 'homegraph.reset', recoverable: true },
    );
  }
  return resolveReadableHomeGraphSpace(store, input);
}

function ambiguousSpaceError(candidates: readonly string[]): GoodVibesError {
  return new GoodVibesError(
    `Several Home Assistant spaces exist (${candidates.join(', ')}) and none is the default; pass installationId or knowledgeSpaceId.`,
    { category: 'bad_request', source: 'runtime', operation: 'homegraph.space', recoverable: true },
  );
}

function hasExplicitSpace(input: HomeGraphSpaceInput): boolean {
  return hasText(input.installationId) || hasText(input.knowledgeSpaceId);
}

/** Home Assistant spaces holding records, newest update first. */
function listHomeGraphSpaces(store: KnowledgeStore): string[] {
  const candidates = new Map<string, number>();
  for (const record of [
    ...store.listSources(Number.MAX_SAFE_INTEGER),
    ...store.listNodes(Number.MAX_SAFE_INTEGER),
    ...store.listIssues(Number.MAX_SAFE_INTEGER),
    ...store.listExtractions(Number.MAX_SAFE_INTEGER),
  ]) {
    const spaceId = getKnowledgeSpaceId(record);
    if (!homeAssistantSpaceComponent(spaceId)) continue;
    candidates.set(spaceId, Math.max(candidates.get(spaceId) ?? 0, record.updatedAt ?? record.createdAt ?? 0));
  }
  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([spaceId]) => spaceId);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
