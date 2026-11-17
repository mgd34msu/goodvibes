import { learningPromotionReference } from './agent-harness-learning-curator-common.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { types as nodeTypes } from 'node:util';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { previewHarnessText } from './agent-harness-text.ts';
import { planMemoryRecord } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { runSkillDraftProposer, assertSkillDraftRunResultCurrent, type SkillDraftRunResult } from '../agent/skill-draft-runner.ts';
import { buildLearningCandidates, assertLearningCandidateCollection } from './agent-harness-learning-curator-proposals.ts';
import type { LearningCandidate } from './agent-harness-learning-curator-types.ts';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingSnapshotGuard, modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import type { LearningCandidateCollection, LearningCuratorNativeContext } from './agent-harness-learning-curator-source.ts';


// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface AutoPromoteResult {
  /** Total candidates seen as ready-to-promote or needs-consolidation. */
  readonly eligible: number;
  /** Records successfully promoted this pass. */
  readonly promoted: number;
  /** Candidates skipped: a write that did not complete, a proposal target this pass cannot write, or missing data. Each one has a line in `log`. */
  readonly skipped: number;
  /** Duplicate records marked stale with originals retained. */
  readonly consolidated: number;
  /** Per-domain breakdown. */
  readonly domains: Record<string, number>;
  /** Brief log lines for each promoted or consolidated item. */
  readonly log: readonly string[];
}

const issuedResults = new WeakMap<AutoPromoteResult, {
  readonly context: LearningCuratorNativeContext;
  readonly options: CatalogRankingOptions;
  readonly assertOutput: (current: unknown) => void;
  readonly assertCurrent: () => void;
}>();

/** Check the exact issued result after rendering and before publication. */
export function assertAutoPromoteResultCurrent(
  result: AutoPromoteResult,
  context: LearningCuratorNativeContext,
  options: CatalogRankingOptions,
): void {
  const issued = issuedResults.get(result);
  if (!issued || issued.context !== context || issued.options !== options)
    throw new ToolInputProjectionError('held');
  issued.assertOutput(result);
  issued.assertCurrent();
  issued.assertOutput(result);
}

function issueResult(result: AutoPromoteResult, context: LearningCuratorNativeContext,
  options: CatalogRankingOptions, assertCurrent: () => void): AutoPromoteResult {
  issuedResults.set(result, { context, options, assertCurrent,
    assertOutput: captureModelReadingSnapshotGuard(result) });
  assertAutoPromoteResultCurrent(result, context, options);
  return result;
}

type LocalRecord = ReturnType<AgentPersonaRegistry['create']>
  | ReturnType<AgentSkillRegistry['create']> | ReturnType<AgentRoutineRegistry['create']>;
type TransitionIntent = Exclude<Parameters<LearningCandidateCollection['prepareTransition']>[0], { readonly domain: 'memory' }>;
class PromotionRestrictionFailure {
  constructor(readonly failure: unknown) {}
}

function splitList(value: string | undefined): string[] {
  return value ? value.split(/[,;]+/).map(entry => entry.trim()).filter(Boolean) : [];
}

function memoryClass(value: string): Parameters<MemoryApi['add']>[0]['cls'] {
  switch (value) {
    case 'decision': case 'constraint': case 'incident': case 'pattern': case 'fact':
    case 'risk': case 'runbook': case 'architecture': case 'ownership': return value;
    default: throw new ToolInputProjectionError('held');
  }
}
function memoryScope(value: string): Parameters<MemoryApi['add']>[0]['scope'] {
  switch (value) {
    case 'session': case 'project': case 'team': return value;
    default: throw new ToolInputProjectionError('held');
  }
}

function writeLocalRecord(
  collection: LearningCandidateCollection,
  intent: TransitionIntent,
  write: (effects: ReturnType<LearningCandidateCollection['prepareTransition']>['effects']) => LocalRecord,
  context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void,
  /** Called the moment the write is durable, before the checks that can still stop the pass. */
  onDurable?: () => void,
): LocalRecord {
  let transition: ReturnType<LearningCandidateCollection['prepareTransition']>;
  try { assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership(); transition = collection.prepareTransition(intent); }
  catch (error) { throw new PromotionRestrictionFailure(error); }
  let restricted = false;
  let returned = false;
  try {
    const result = write({
      assertCurrent: () => {
        try { assertOwnership(); assertLearningCandidateCollection(collection, context, options); transition.effects.assertCurrent(); assertOwnership(); }
        catch (error) { restricted = true; throw error; }
      },
      onEffect: published => {
        if (published === true) onDurable?.();
        try { assertOwnership(); transition.effects.onEffect(published); assertOwnership(); }
        catch (error) { restricted = true; throw error; }
      },
    });
    returned = true;
    transition.commit(result); assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership();
    return result;
  } catch (error) {
    try { transition.abort(); } catch (failure) { throw new PromotionRestrictionFailure(failure); }
    if (returned || restricted || error instanceof ToolInputProjectionError || collection.options.signal?.aborted)
      throw new PromotionRestrictionFailure(error);
    try { assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership(); } catch (failure) { throw new PromotionRestrictionFailure(failure); }
    throw error;
  }
}

async function promoteMemory(
  api: MemoryApi, candidate: LearningCandidate, collection: LearningCandidateCollection,
  options: CatalogRankingOptions, context: LearningCuratorNativeContext, assertOwnership: () => void,
  onDurable?: () => void,
): Promise<string> {
  const fields = candidate.proposalFields ?? {};
  const summary = (fields.summary ?? fields.detail ?? candidate.label).trim();
  const detail = (fields.detail ?? '').trim();
  const confidence = fields.confidence === undefined ? undefined : Number(fields.confidence);
  if (!summary || !detail || confidence === undefined || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 100 || String(confidence) !== fields.confidence)
    throw new ToolInputProjectionError('held');
  const input = {
    scope: memoryScope((fields.scope ?? 'project').trim()),
    cls: memoryClass((fields.cls ?? 'fact').trim()), summary,
    detail, tags: splitList(fields.tags), review: { confidence },
    provenance: [{ kind: 'event', ref: learningPromotionReference(candidate.id) }],
  } satisfies Parameters<MemoryApi['add']>[0];
  let transition: ReturnType<LearningCandidateCollection['prepareTransition']> | undefined;
  try {
    assertOwnership(); assertLearningCandidateCollection(collection, context, options);
    // The record is planned before the write so the transition is staged with it;
    // the store inserts exactly this record and completes the transition at the insert.
    const planned = planMemoryRecord(input);
    const owned = collection.prepareTransition({ kind: 'create', domain: 'memory', input, preparedRecord: planned });
    transition = owned;
    const record = await api.add(input, {
      signal: options.signal,
      // Checked by the store immediately before the insert, the one step that cannot be undone.
      assertCurrent: () => {
        options.assertCurrent?.();
        assertOwnership(); assertLearningCandidateCollection(collection, context, options);
        owned.effects.assertCurrent();
      },
    }, {
      id: planned.id, createdAt: planned.createdAt,
      onInserted: inserted => {
        onDurable?.();
        owned.effects.onEffect(true);
        owned.commit(inserted);
      },
    });
    return `memory:${record.id}  ${summary.slice(0, 60)}`;
  } catch (error) {
    try { transition?.abort(); } catch (failure) { throw new PromotionRestrictionFailure(failure); }
    throw new PromotionRestrictionFailure(error);
  }
}

function promotePersona(paths: ShellPathService, candidate: LearningCandidate, collection: LearningCandidateCollection, context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void, onDurable?: () => void): string {
  const fields = candidate.proposalFields ?? {};
  const name = (fields.name ?? candidate.label).trim();
  const body = (fields.body ?? fields.detail ?? '').trim();
  if (!name || !body) throw new ToolInputProjectionError('held');
  const input = {
    name, description: (fields.description ?? name).trim(),
    body, triggers: splitList(fields.triggers),
    tags: splitList(fields.tags), source: 'agent', provenance: learningPromotionReference(candidate.id),
  } satisfies Parameters<AgentPersonaRegistry['create']>[0];
  const record = writeLocalRecord(collection, { kind: 'create', domain: 'persona', input },
    effects => AgentPersonaRegistry.fromShellPaths(paths, effects).create(input), context, options, assertOwnership, onDurable);
  return `persona:${record.id}  ${name.slice(0, 60)}`;
}

function promoteRoutine(paths: ShellPathService, candidate: LearningCandidate, collection: LearningCandidateCollection, context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void, onDurable?: () => void): string {
  const fields = candidate.proposalFields ?? {};
  const name = (fields.name ?? candidate.label).trim();
  const steps = (fields.steps ?? fields.notes ?? fields.detail ?? '').trim();
  if (!name || !steps) throw new ToolInputProjectionError('held');
  const input = {
    name, description: (fields.description ?? name).trim(),
    steps,
    // Text from notes and sessions becomes a standing routine only after the owner enables it.
    triggers: splitList(fields.triggers), tags: splitList(fields.tags), enabled: false,
    source: 'agent', provenance: learningPromotionReference(candidate.id),
  } satisfies Parameters<AgentRoutineRegistry['create']>[0];
  const record = writeLocalRecord(collection, { kind: 'create', domain: 'routine', input },
    effects => AgentRoutineRegistry.fromShellPaths(paths, effects).create(input), context, options, assertOwnership, onDurable);
  return `routine:${record.id}  ${name.slice(0, 60)}`;
}

/** Writes already made by a consolidation, kept outside the call so a later failure cannot hide them. */
interface ConsolidationProgress { count: number; readonly lines: string[] }

/** Duplicates not yet staged; a staged one is only waiting for deletion and is never rewritten. */
function pendingDuplicates(plan: NonNullable<LearningCandidate['consolidation']>): readonly string[] {
  const staged = new Set(plan.staleDuplicateIds ?? []);
  return plan.duplicateIds.filter(id => !staged.has(id));
}

function failureKind(error: unknown): string {
  return previewHarnessText(summarizeError(error), 100);
}

/** Records what an interrupted pass already changed on the error, and in the log, so completed writes are never lost from view. */
function withPartialProgress(failure: unknown, ledger: readonly string[]): unknown {
  if (ledger.length === 0) return failure;
  logger.warn('Learning auto-promotion stopped after completed writes', { completed: ledger });
  if (failure !== null && typeof failure === 'object') Object.assign(failure, { completedWrites: [...ledger] });
  // A projection error's text says "nothing was executed"; with writes already made that would be false.
  if (failure instanceof Error) failure.message = `${failure.message} Writes already made before it stopped: ${ledger.join('; ')}.`;
  return failure;
}

/** The writes an interrupted promotion pass had already made, if it was interrupted after any. */
export function completedPromotionWrites(error: unknown): readonly string[] {
  if (error === null || typeof error !== 'object') return [];
  const writes: unknown = (error as { readonly completedWrites?: unknown }).completedWrites;
  return Array.isArray(writes) ? writes.filter((line): line is string => typeof line === 'string') : [];
}

function consolidate(
  paths: ShellPathService, candidate: LearningCandidate, collection: LearningCandidateCollection,
  context: LearningCuratorNativeContext, options: CatalogRankingOptions, assertOwnership: () => void,
  progress: ConsolidationProgress,
): void {
  const plan = candidate.consolidation;
  const domain = candidate.domain;
  if (!plan || (domain !== 'persona' && domain !== 'skill' && domain !== 'routine'))
    throw new Error('Unsupported local consolidation.');
  // The survivor is never rewritten: it keeps its own provenance, which may be the reference that marks a candidate as already promoted.
  for (const id of pendingDuplicates(plan)) {
    const reason = `Duplicate of ${plan.survivorId}; staged by learning curator consolidation.`;
    writeLocalRecord(collection, { kind: 'stale', domain, id, reason }, effects => {
      if (domain === 'persona') return AgentPersonaRegistry.fromShellPaths(paths, effects).markStale(id, reason);
      if (domain === 'skill') return AgentSkillRegistry.fromShellPaths(paths, effects).markStale(id, reason);
      return AgentRoutineRegistry.fromShellPaths(paths, effects).markStale(id, reason);
    }, context, options, assertOwnership, () => {
      progress.count++; progress.lines.push(`marked duplicate ${domain}:${id} stale; ${plan.survivorId} is kept`);
    });
  }
}

/** Use the caller's recorded admission for all planned local promotions. */
async function runAutoPromoterOnce(
  context: LearningCuratorNativeContext, skillRegistry: AgentSkillRegistry, memoryApi: MemoryApi,
  options: CatalogRankingOptions, memoryServedByDaemon: boolean,
): Promise<AutoPromoteResult> {
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  const signal = options.signal, caller = options.assertCurrent;
  const assertSignal = signal ? captureCatalogMethods(signal, ['throwIfAborted']) : () => {};
  if (typeof caller !== 'function') throw new ToolInputProjectionError('unavailable');
  const assertCaller = () => {
    assertOptions(); assertSignal(); signal?.throwIfAborted();
    const result: unknown = caller();
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
      throw new ToolInputProjectionError('stale');
    }
    assertOptions(); assertSignal(); signal?.throwIfAborted();
  };
  assertCaller();
  const assertWorkspace = captureCatalogMethods(context, ['workspace']);
  const paths = context.workspace?.shellPaths;
  if (!paths) {
    const workspace = context.workspace;
    const assertPath = workspace ? captureCatalogMethods(workspace, ['shellPaths']) : () => {};
    const assertEmpty = () => {
      assertWorkspace(); assertPath(); assertCaller(); assertWorkspace(); assertPath();
      if (context.workspace !== workspace || modelReadingServicePath(context, ['workspace', 'shellPaths']) !== paths)
        throw new ToolInputProjectionError('stale');
    };
    return issueResult({ eligible: 0, promoted: 0, skipped: 0, consolidated: 0,
      domains: {}, log: ['No active workspace; promotion skipped.'] }, context, options, assertEmpty);
  }
  const assertApi = captureCatalogMethods(memoryApi, ['add', 'getAll']);
  const factories = [AgentPersonaRegistry, AgentSkillRegistry, AgentRoutineRegistry]
    .map(factory => captureCatalogMethods(factory, ['prototype', 'fromShellPaths']));
  const nativeMethods = [
    captureCatalogMethods(AgentPersonaRegistry.prototype, ['constructor', 'snapshot', 'readStore', 'writeStore', 'nextId', 'validateRequired', 'create', 'update', 'markStale', 'deletePersona']),
    captureCatalogMethods(AgentSkillRegistry.prototype, ['constructor', 'snapshot', 'readStore', 'writeStore', 'nextId', 'validateRequired', 'create', 'update', 'markStale', 'deleteSkill']),
    captureCatalogMethods(AgentRoutineRegistry.prototype, ['constructor', 'snapshot', 'readStore', 'writeStore', 'nextId', 'validateRequired', 'create', 'update', 'markStale', 'deleteRoutine']),
  ];
  const assertOwnership = () => {
    assertOptions(); assertSignal(); assertWorkspace(); assertApi(); for (const guard of [...factories, ...nativeMethods]) guard();
    signal?.throwIfAborted();
    if (context.workspace?.shellPaths !== paths || context.clients?.agentKnowledgeApi?.memory !== memoryApi)
      throw new ToolInputProjectionError('stale');
  };
  assertOwnership(); assertCaller(); assertOwnership();
  const collection = await buildLearningCandidates(context, options);
  assertLearningCandidateCollection(collection, context, options);
  let skillResult: SkillDraftRunResult | undefined;
  const assertCurrent = () => {
    assertOwnership(); assertLearningCandidateCollection(collection, context, options);
    if (skillResult) assertSkillDraftRunResultCurrent(skillResult, context, options);
    assertOwnership();
  };
  assertCurrent();
  const promotions = collection.candidates.filter(candidate => candidate.status === 'ready-to-promote'
    || candidate.status === 'proposal-ready');
  const consolidations = collection.candidates.filter(candidate => candidate.status === 'needs-consolidation'
    && candidate.consolidation !== undefined && candidate.domain !== 'memory'
    && pendingDuplicates(candidate.consolidation).length > 0);
  const eligible = promotions.length + consolidations.length;
  const log: string[] = [], domains: Record<string, number> = {};
  let promoted = 0, skipped = 0, consolidated = 0;
  const bump = (domain: string) => { domains[domain] = (domains[domain] ?? 0) + 1; };
  const skills = await runSkillDraftProposer(context, skillRegistry, options, collection);
  skillResult = skills;
  assertCurrent();
  for (const entry of skills.entries) { log.push(`promoted skill:${entry.skillId}  ${entry.name}`); bump('skill'); }
  promoted += skills.proposed; skipped += skills.skipped;
  for (const candidate of promotions) {
    if (candidate.proposalTarget === 'skill') continue;
    assertCurrent();
    collection.assertCandidateCurrent(candidate);
    assertCurrent();
    // An adopted daemon is the single writer of the shared memory store; this pass only
    // holds the boot-time local copy, so writing there would fork the two.
    if (candidate.proposalTarget === 'memory' && memoryServedByDaemon) {
      skipped++;
      log.push(`Skipped ${candidate.id}: memory is served by the connected daemon, which this pass cannot write to. Create it with agent_local_registry domain:"memory" action:"create".`);
      continue;
    }
    // Set once the record is durable and cleared when it is logged, so a stop in between still reports it.
    let durable = false;
    const onDurable = () => { durable = true; };
    const ledger = () => durable ? [...log, `wrote ${candidate.proposalTarget} for ${candidate.id}; the checks after the write stopped the pass`] : log;
    try {
      let line: string;
      if (candidate.proposalTarget === 'memory') line = await promoteMemory(memoryApi, candidate, collection, options, context, assertOwnership, onDurable);
      else if (candidate.proposalTarget === 'persona') line = promotePersona(paths, candidate, collection, context, options, assertOwnership, onDurable);
      else if (candidate.proposalTarget === 'routine') line = promoteRoutine(paths, candidate, collection, context, options, assertOwnership, onDurable);
      else { skipped++; log.push(`Skipped ${candidate.id}: the ${candidate.proposalTarget ?? 'unknown'} proposal target is not written by this pass.`); continue; }
      assertCurrent();
      promoted++; bump(candidate.proposalTarget); log.push(`promoted ${line}`); durable = false;
    } catch (error) {
      if (error instanceof PromotionRestrictionFailure) throw withPartialProgress(error.failure, ledger());
      if (error instanceof ToolInputProjectionError || signal?.aborted) throw withPartialProgress(error, ledger());
      assertCurrent(); skipped++; log.push(`Promotion of ${candidate.id} did not complete (${failureKind(error)}).`);
    }
  }
  for (const candidate of consolidations) {
    assertCurrent();
    collection.assertCandidateCurrent(candidate);
    assertCurrent();
    // Each stale write is counted as it lands, so a later failure in the same group still reports the earlier ones.
    const progress: ConsolidationProgress = { count: 0, lines: [] };
    const settle = () => { consolidated += progress.count; if (progress.count > 0) bump(candidate.domain); log.push(...progress.lines); };
    try {
      consolidate(paths, candidate, collection, context, options, assertOwnership, progress);
      assertCurrent(); settle();
    } catch (error) {
      settle();
      if (error instanceof PromotionRestrictionFailure) throw withPartialProgress(error.failure, log);
      if (error instanceof ToolInputProjectionError || signal?.aborted) throw withPartialProgress(error, log);
      assertCurrent(); skipped++;
      log.push(`Consolidation of ${candidate.id} did not complete after ${progress.count} of ${candidate.consolidation ? pendingDuplicates(candidate.consolidation).length : 0} duplicates (${failureKind(error)}).`);
    }
  }
  assertCurrent();
  return issueResult({ eligible, promoted, skipped, consolidated, domains, log }, context, options, assertCurrent);
}

const activePromotions = new Map<string, Promise<AutoPromoteResult>>();
/** Serialize native writes; each caller keeps its own source/permission lifetime. */
export async function runAutoPromoter(context: LearningCuratorNativeContext, skills: AgentSkillRegistry,
  memory: MemoryApi, options: CatalogRankingOptions, memoryServedByDaemon = false): Promise<AutoPromoteResult> {
  const assertContext = captureCatalogMethods(context, ['workspace']);
  const workspace = modelReadingServicePath(context, ['workspace']);
  const paths = modelReadingServicePath(context, ['workspace', 'shellPaths']);
  const root = modelReadingServicePath(context, ['workspace', 'shellPaths', 'userGoodVibesRoot']);
  if (typeof root !== 'string' || !root) return runAutoPromoterOnce(context, skills, memory, options, memoryServedByDaemon);
  const assertOptions = captureCatalogMethods(options, ['signal', 'assertCurrent']);
  const signal = options.signal;
  const current = () => {
    assertContext(); assertOptions(); signal?.throwIfAborted();
    if (modelReadingServicePath(context, ['workspace']) !== workspace
      || modelReadingServicePath(context, ['workspace', 'shellPaths']) !== paths
      || modelReadingServicePath(context, ['workspace', 'shellPaths', 'userGoodVibesRoot']) !== root) throw new ToolInputProjectionError('stale');
  };
  current();
  const previous = activePromotions.get(root);
  const pass = (async () => {
    if (previous) await previous.catch(() => {});
    current(); return runAutoPromoterOnce(context, skills, memory, options, memoryServedByDaemon);
  })();
  activePromotions.set(root, pass);
  const cleanup = () => { if (activePromotions.get(root) === pass) activePromotions.delete(root); };
  void pass.then(cleanup, cleanup);
  if (!signal) return pass;
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new ToolInputProjectionError('stale'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pass, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
