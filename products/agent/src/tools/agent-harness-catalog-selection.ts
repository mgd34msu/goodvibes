import { LIMITS } from '@goodvibes-jev/judgment';
import { types as nodeTypes } from 'node:util';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { registryCatalogGroupFit, registrySelect, ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogMethods, captureCatalogSnapshot, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { activateClassicFallback, decisionOrClassic, isClassicOperation, selectClassicCatalog } from '@goodvibes-jev/engine/platform/platform/runtime';

function requireSynchronousRestriction(result: unknown): void {
  if (result === undefined) return;
  if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
  throw new ToolInputProjectionError('held');
}

/** Original callbacks and the protected owner are restriction sources, never replacement authority. */
export function captureCatalogReadRequest<T>(input: T, options: CatalogRankingOptions) {
  const request = captureCatalogSnapshot(input);
  const allowed = ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource'];
  const assertOptions = captureCatalogMethods(options, allowed);
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) throw new ToolInputProjectionError('invalid');
  const { signal, sourceOwner, assertCurrent: originalAssert, retainCurrent: originalRetain, requirePreservedSource } = options;
  if ([originalAssert, originalRetain].some(callback => callback !== undefined
    && (typeof callback !== 'function' || nodeTypes.isProxy(callback)))) throw new ToolInputProjectionError('invalid');
  const assertOwner = sourceOwner ? captureCatalogMethods(sourceOwner, ['capture', 'screen', 'project', 'release']) : () => {};
  const retained = new Set<() => void>();
  const throwIfAborted = AbortSignal.prototype.throwIfAborted;
  const assertBinding = () => {
    assertOptions(); assertOwner();
    const current = Reflect.ownKeys(options);
    if (current.length !== keys.length || current.some((key, index) => key !== keys[index])) throw new ToolInputProjectionError('held');
    if (signal) Reflect.apply(throwIfAborted, signal, []);
    request.assertCurrent(input);
  };
  const assertCurrent = () => {
    assertBinding();
    requireSynchronousRestriction(originalAssert?.());
    assertBinding();
    for (const guard of retained) {
      requireSynchronousRestriction(guard());
      assertBinding();
    }
  };
  const retain = (guard: () => void, key?: string) => {
    assertBinding();
    if (typeof guard !== 'function' || nodeTypes.isProxy(guard)) throw new ToolInputProjectionError('invalid');
    retained.add(guard);
    requireSynchronousRestriction(originalRetain?.(guard, key));
    assertCurrent();
  };
  assertBinding();
  return { input: request.captured, assertCurrent, retain,
    options: Object.freeze({ signal, sourceOwner, assertCurrent, retainCurrent: retain,
      ...(requirePreservedSource === undefined ? {} : { requirePreservedSource }) }) };
}

/** Capture both native stages before an outer source owner or restriction can run. */
export function captureHarnessCatalogSelectionSource(site: string): () => void {
  if (isClassicOperation()) return () => { isClassicOperation(); };
  const assertRegistry = captureCatalogMethods(gateJudgmentRegistry, ['get']);
  const getDefinition = gateJudgmentRegistry.get;
  const assertGroup = captureCatalogMethods(registryCatalogGroupFit, ['name', 'version', 'description', 'accuracyFloor', 'model', 'fixtureCount', 'checkFixtures', 'rerank']);
  const assertSelection = captureCatalogMethods(registrySelect, ['name', 'version', 'description', 'accuracyFloor', 'model', 'fixtureCount', 'checkFixtures', 'select']);
  let installation: ReturnType<ReturnType<typeof captureJudgmentPort>['consumeObservation']>;
  try { installation = captureJudgmentPort(site).consumeObservation(); }
  catch (error) {
    if (!activateClassicFallback(error)) throw error;
    return () => { isClassicOperation(); };
  }
  const assertCurrent = () => {
    // A Preferred outage retires the unused decision backend, not the native
    // catalog/source restrictions retained by the caller.
    if (isClassicOperation()) return;
    assertRegistry(); assertGroup(); assertSelection(); installation.assertCurrent();
    if (getDefinition.call(gateJudgmentRegistry, registryCatalogGroupFit.name) !== registryCatalogGroupFit
      || getDefinition.call(gateJudgmentRegistry, registrySelect.name) !== registrySelect) throw new ToolInputProjectionError('held');
  };
  assertCurrent();
  return assertCurrent;
}

/** Read every complete group; only one settled affirmative group can scope a record choice. */
export async function selectHarnessCatalogGroup<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly description: string },
  options: CatalogRankingOptions = {}, site = 'agent.catalog.group', contextEvidence?: unknown): Promise<T | null> {
  return decisionOrClassic(() => selectDecisionHarnessCatalogGroup(entries, query, describe, options, site, contextEvidence),
    () => classicCatalogSelection(entries, query, entry => {
      const id: unknown = entry && typeof entry === 'object' ? Object.getOwnPropertyDescriptor(entry, 'id')?.value : undefined;
      const description = describe(entry).description;
      return { id: typeof id === 'string' ? id : description, description };
    }, options, site, contextEvidence));
}

async function selectDecisionHarnessCatalogGroup<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly description: string }, options: CatalogRankingOptions, site: string, contextEvidence?: unknown): Promise<T | null> {
  const request = captureCatalogReadRequest({ query, ...(contextEvidence === undefined ? {} : { context: contextEvidence }) }, options);
  const source = captureCatalogSnapshot(entries);
  const assertRegistry = captureCatalogMethods(gateJudgmentRegistry, ['get']);
  const getDefinition = gateJudgmentRegistry.get;
  const assertDefinition = captureCatalogMethods(registryCatalogGroupFit, ['name', 'version', 'description', 'accuracyFloor', 'model', 'fixtureCount', 'checkFixtures', 'rerank']);
  const installation = entries.length
    ? captureJudgmentPort(site, { signal: request.options.signal }).consumeObservation() : undefined;
  const assertBackend = () => {
    if (isClassicOperation()) { request.options.signal?.throwIfAborted(); return; }
    assertRegistry(); assertDefinition(); installation?.assertCurrent();
    if (getDefinition.call(gateJudgmentRegistry, registryCatalogGroupFit.name) !== registryCatalogGroupFit) throw new ToolInputProjectionError('held');
  };
  assertBackend();
  request.retain(assertBackend, `${site}:definition`);
  request.retain(() => source.assertCurrent(entries), `${site}:source`);
  request.assertCurrent();
  const ranked = await rankHarnessCatalog(source.captured.map((entry, index) => ({ index, entry })), request.input.query,
    row => ({ id: String(row.index), description: describe(row.entry).description, evidence: { record: row.entry } }), site,
    { ...request.options, requirePreservedSource: true }, registryCatalogGroupFit.name, request.input.context);
  request.assertCurrent();
  if (ranked.provenance === 'classic') return classicCatalogSelection(entries, query, entry => {
    const id: unknown = entry && typeof entry === 'object' ? Object.getOwnPropertyDescriptor(entry, 'id')?.value : undefined;
    const description = describe(entry).description;
    return { id: typeof id === 'string' ? id : description, description };
  }, options, site, contextEvidence);
  if (ranked.judgments.length !== entries.length || new Set(ranked.judgments.map(reading => reading.id)).size !== entries.length) throw new ToolInputProjectionError('held');
  const matches: T[] = [];
  for (const judgment of ranked.judgments) {
    if (!/^(0|[1-9][0-9]*)$/.test(judgment.id)) throw new ToolInputProjectionError('held');
    const entry = entries[Number(judgment.id)];
    if (entry === undefined || judgment.reading.outcome !== 'act'
      || (judgment.reading.verdict !== 'yes' && judgment.reading.verdict !== 'no')) throw new ToolInputProjectionError('held');
    if (judgment.reading.verdict === 'yes') matches.push(entry);
  }
  request.assertCurrent();
  return matches.length === 1 ? matches[0] ?? null : null;
}

/** A complete screened choice maps only to the original local row. */
export async function selectHarnessCatalog<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  options: CatalogRankingOptions = {}, site = 'agent.catalog.select', contextEvidence?: unknown): Promise<T | null> {
  return decisionOrClassic(() => selectDecisionHarnessCatalog(entries, query, describe, options, site, contextEvidence),
    () => classicCatalogSelection(entries, query, describe, options, site, contextEvidence));
}

async function classicCatalogSelection<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  options: CatalogRankingOptions, site: string, contextEvidence?: unknown): Promise<T | null> {
  const request = captureCatalogReadRequest({ query, ...(contextEvidence === undefined ? {} : { context: contextEvidence }) }, options);
  const source = captureCatalogSnapshot(entries);
  const assertSource = () => source.assertCurrent(entries);
  request.retain(assertSource, `${site}:classic-source`);
  request.assertCurrent();
  const catalog = source.captured.map((entry, index) => ({ index, ...describe(entry) }));
  return withModelReadingSource({ ...request.input, catalog, records: source.captured }, {
    signal: request.options.signal, sourceOwner: request.options.sourceOwner,
    assertCurrent: request.assertCurrent, retainCurrent: request.retain,
  }, async (captured, reading) => {
    reading.assertCurrent?.();
    const selected = selectClassicCatalog(captured.catalog, captured.query, item => item);
    reading.assertCurrent?.();
    return selected === null ? null : entries[selected.index] ?? null;
  });
}

async function selectDecisionHarnessCatalog<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  options: CatalogRankingOptions, site: string, contextEvidence?: unknown): Promise<T | null> {
  const request = captureCatalogReadRequest({ query, ...(contextEvidence === undefined ? {} : { context: contextEvidence }) }, options);
  const source = captureCatalogSnapshot(entries);
  const assertRegistry = captureCatalogMethods(gateJudgmentRegistry, ['get']);
  const getDefinition = gateJudgmentRegistry.get;
  const assertDefinition = captureCatalogMethods(registrySelect, ['name', 'version', 'description', 'accuracyFloor', 'model', 'fixtureCount', 'checkFixtures', 'select']);
  const select = registrySelect.select;
  // Acquire installation identity without invoking the original caller's
  // restrictions. The observation is only a retained publication restriction.
  const installation = entries.length
    ? captureJudgmentPort(site, { signal: request.options.signal }).consumeObservation() : undefined;
  const assertBackend = () => {
    if (isClassicOperation()) { request.options.signal?.throwIfAborted(); return; }
    assertRegistry(); assertDefinition(); installation?.assertCurrent();
    if (getDefinition.call(gateJudgmentRegistry, registrySelect.name) !== registrySelect) throw new ToolInputProjectionError('held');
  };
  assertBackend();
  const assertCurrent = () => { assertBackend(); request.assertCurrent(); source.assertCurrent(entries); assertBackend(); };
  request.retain(assertBackend, `${site}:definition`);
  request.retain(() => source.assertCurrent(entries), `${site}:source`);
  const readingOptions = { ...request.options, assertCurrent };
  assertCurrent();
  const catalog = source.captured.map(describe);
  if (new Set(catalog.map(entry => entry.id)).size !== entries.length) throw new ToolInputProjectionError('held');
  return withModelReadingSource({ ...request.input, catalog, records: source.captured }, readingOptions, async (captured, current) => {
    current.assertCurrent?.();
    if (!entries.length) return null;
    if (entries.length >= LIMITS.maxChoiceOptions) throw new ToolInputProjectionError('held');
    assertBackend();
    current.retainCurrent?.(assertBackend, `${site}:definition`);
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: () => { current.assertCurrent?.(); assertBackend(); },
      prepareResultCapture: prepareJudgmentResult });
    try {
      const contextJson = contextEvidence === undefined ? undefined : JSON.stringify(captured.context);
      if (contextEvidence !== undefined && typeof contextJson !== 'string') throw new ToolInputProjectionError('held');
      const result = await select.call(registrySelect, authority.port, { query: captured.query,
        ...(contextJson === undefined ? {} : { contextJson }),
      }, captured.catalog.map((entry, index) => ({
        id: String(index), content: JSON.stringify({ ...entry, record: captured.records[index] }),
      })), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); current.assertCurrent?.();
      result.recordAction('read-only catalog detail selection');
      authority.assertCurrent(); current.assertCurrent?.();
      if (result.outcome !== 'act') throw new ToolInputProjectionError('held');
      if (result.pick.choice === 'none') {
        if (result.chosen !== undefined) throw new ToolInputProjectionError('held');
        return null;
      }
      if (result.chosen === undefined || !/^(0|[1-9][0-9]*)$/.test(result.chosen)) throw new ToolInputProjectionError('held');
      const entry = entries[Number(result.chosen)];
      if (entry === undefined || result.pick.choice !== result.chosen) throw new ToolInputProjectionError('held');
      return entry;
    } finally {
      const observation = authority.consumeObservation();
      current.retainCurrent?.(observation.assertCurrent, `${site}:backend`);
      observation.assertCurrent(); assertBackend(); current.assertCurrent?.();
    }
  });
}
