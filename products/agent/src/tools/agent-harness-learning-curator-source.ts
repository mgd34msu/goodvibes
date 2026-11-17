import fs from 'node:fs';
import type { MemoryAddOptions } from '@goodvibes-jev/engine/platform/platform/state';
import type { AgentPersonaCreateInput, AgentPersonaUpdateInput } from '../agent/persona-registry.ts';
import type { AgentSkillCreateInput, AgentSkillUpdateInput } from '../agent/skill-registry.ts';
import type { AgentRoutineCreateInput, AgentRoutineUpdateInput } from '../agent/routine-registry.ts';
import { AgentNoteRegistry } from '../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentResearchRunRegistry } from '../agent/research-run-registry.ts';
import { summarizeMemoryItem, summarizeNoteItem, summarizePersonaItem, summarizeSkillItem, summarizeSkillBundleItem, summarizeRoutineItem } from '../input/agent-workspace-local-library-snapshot.ts';
import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { captureWorkPlanTasks, ProjectWorkPlan, type ProjectWorkPlanTask } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData, captureCatalogSnapshotGuard, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath, captureModelReadingSnapshotGuard } from './agent-harness-model-reading-source.ts';
import { discoverVibeFiles } from '../agent/vibe-file.ts';
import type { LocalLearningCandidateDomain, LearningCandidate } from './agent-harness-learning-curator-types.ts';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';

/** A work-plan task as the curator reads it: the row's fields under the record id the readings use. */
export interface LearningWorkItem {
  readonly id: string;
  readonly title: string;
  readonly status: ProjectWorkPlanTask['status'];
  readonly owner?: string | undefined;
  readonly source?: string | undefined;
  readonly notes?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
}

function learningWorkItem(task: ProjectWorkPlanTask): LearningWorkItem {
  return {
    id: task.taskId,
    title: task.title,
    status: task.status,
    ...(task.owner ? { owner: task.owner } : {}),
    ...(task.source ? { source: task.source } : {}),
    ...(task.notes ? { notes: task.notes } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
  };
}

/** A write the curator is about to make through a registry, which alone owns the record's format. */
export type LearningTransitionIntent =
  | { readonly kind: 'create'; readonly domain: 'persona'; readonly input: AgentPersonaCreateInput }
  | { readonly kind: 'create'; readonly domain: 'skill'; readonly input: AgentSkillCreateInput }
  | { readonly kind: 'create'; readonly domain: 'routine'; readonly input: AgentRoutineCreateInput }
  | { readonly kind: 'create'; readonly domain: 'memory'; readonly input: MemoryAddOptions }
  | { readonly kind: 'update'; readonly domain: 'persona'; readonly id: string; readonly input: AgentPersonaUpdateInput }
  | { readonly kind: 'update'; readonly domain: 'skill'; readonly id: string; readonly input: AgentSkillUpdateInput }
  | { readonly kind: 'update'; readonly domain: 'routine'; readonly id: string; readonly input: AgentRoutineUpdateInput }
  | { readonly kind: 'stale'; readonly domain: 'persona' | 'skill' | 'routine'; readonly id: string; readonly reason: string }
  | { readonly kind: 'delete'; readonly domain: 'persona' | 'skill' | 'routine'; readonly id: string };

export interface LearningSourceTransition {
  readonly effects: { readonly assertCurrent: () => void; readonly onEffect: (published?: boolean) => void };
  /** After the registry's own write: the source is read once and becomes the new baseline. */
  readonly commit: (record: unknown) => void;
  readonly abort: () => void;
}

export interface LearningRecord {
  readonly item: AgentWorkspaceLocalLibraryItem;
  readonly record: unknown;
}

export interface LearningCuratorNativeContext {
  readonly workspace?: Pick<CommandContext['workspace'], 'shellPaths'> & { readonly workPlan?: Pick<NonNullable<CommandContext['workspace']['workPlan']>, 'snapshotNow'> };
  readonly clients?: { readonly agentKnowledgeApi?: { readonly memory?: Pick<MemoryApi, 'getAll'> } };
  readonly session?: {
    readonly sessionManager?: Pick<NonNullable<CommandContext['session']['sessionManager']>, 'list' | 'load'>
      & Partial<Pick<NonNullable<CommandContext['session']['sessionManager']>, 'fingerprint'>>;
    readonly runtime?: Pick<CommandContext['session']['runtime'], 'sessionId'>;
  };
}

export function acquireLearningCuratorSource(context: LearningCuratorNativeContext, options: CatalogRankingOptions) {
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const synchronous = (check: () => unknown) => assertSynchronousJudgmentGuard(check, () => new ToolInputProjectionError('held'));
  let calling = false;
  const assertCaller = () => {
    if (calling) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted();
    if (callerCurrent) {
      calling = true;
      try { synchronous(callerCurrent); } finally { calling = false; }
    }
    signal?.throwIfAborted();
  };
  assertCaller();
  const paths = [
    ['workspace', 'shellPaths'], ['workspace', 'workPlan'], ['clients', 'agentKnowledgeApi', 'memory'],
    ['session', 'sessionManager'], ['session', 'runtime'],
  ];
  const identities = paths.map(keys => {
    let parent: unknown = context;
    for (const key of keys) {
      parent = modelReadingServicePath(parent, [key]);
    }
    return { keys, value: parent };
  });
  const memory = context.clients?.agentKnowledgeApi?.memory;
  const work = context.workspace?.workPlan;
  const manager = context.session?.sessionManager;
  const runtime = context.session?.runtime;
  const sessionId = runtime?.sessionId;
  const shellPaths = context.workspace?.shellPaths;
  const notes = shellPaths ? AgentNoteRegistry.fromShellPaths(shellPaths) : undefined;
  const personas = shellPaths ? AgentPersonaRegistry.fromShellPaths(shellPaths) : undefined;
  const skills = shellPaths ? AgentSkillRegistry.fromShellPaths(shellPaths) : undefined;
  const routines = shellPaths ? AgentRoutineRegistry.fromShellPaths(shellPaths) : undefined;
  const research = shellPaths ? AgentResearchRunRegistry.fromShellPaths(shellPaths) : undefined;
  const capturedAt = Date.now();
  if (!Number.isSafeInteger(capturedAt) || Math.abs(capturedAt) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
  // This clock is generated by this native owner, never discovered by a field name.
  const capturedAtForReading = new Date(capturedAt).toISOString();
  const retained = new Set<() => void>();
  // This guard never invokes the caller whose publication map retains it.
  const assertNative = () => {
    signal?.throwIfAborted();
    for (const identity of identities) if (modelReadingServicePath(context, identity.keys) !== identity.value) throw new ToolInputProjectionError('stale');
    if (runtime?.sessionId !== sessionId) throw new ToolInputProjectionError('stale');
  };
  const assertReadingBackends = () => { assertNative(); for (const guard of retained) guard(); assertNative(); };
  assertNative();
  // One read of the plan's rows; later reads compare the plan's revision (one indexed
  // statement) and refuse with the work plan named when an edit committed since.
  const nativeWorkItems = work instanceof ProjectWorkPlan ? captureWorkPlanTasks(work) : undefined;
  const nativeLearningItems = nativeWorkItems?.tasks.map(learningWorkItem);
  const readWorkItems = (): readonly LearningWorkItem[] => {
    if (!nativeWorkItems || !nativeLearningItems) return (work?.snapshotNow().tasks ?? []).map(learningWorkItem);
    nativeWorkItems.assertCurrent();
    return nativeLearningItems;
  };
  // Parsing every saved session on each currentness check grows with the number of sessions.
  // When no session file changed (same fingerprint, which a save always changes), the last
  // full reading of them stands; publication points still read everything.
  const readSessionList = () => captureCatalogData(manager?.list() ?? []);
  const readSessionBodies = (list: ReturnType<typeof readSessionList>) =>
    list.filter(session => session.name !== sessionId).map(session => ({ session, loaded: captureCatalogData(manager?.load(session.name)) }));
  let sessionReading: { readonly fingerprint: string; readonly sessionList: ReturnType<typeof readSessionList>; readonly sessions: ReturnType<typeof readSessionBodies> } | undefined;
  const read = (reuseSessions = false) => {
    assertNative();
    const memoryRecords = captureCatalogData(memory?.getAll() ?? []);
    const noteSnapshot = captureCatalogData(notes?.snapshot());
    const personaSnapshot = captureCatalogData(personas?.snapshot());
    const skillSnapshot = captureCatalogData(skills?.snapshot());
    const routineSnapshot = captureCatalogData(routines?.snapshot());
    const researchSnapshot = captureCatalogData(research?.snapshot());
    const registryFiles = [
      { domain: 'note', path: noteSnapshot?.path }, { domain: 'persona', path: personaSnapshot?.path },
      { domain: 'skill', path: skillSnapshot?.path }, { domain: 'routine', path: routineSnapshot?.path },
      { domain: 'research', path: researchSnapshot?.path },
    ].filter((file): file is { domain: string; path: string } => typeof file.path === 'string').map(file => {
      const exists = fs.existsSync(file.path);
      return { ...file, exists, bytes: exists ? fs.readFileSync(file.path, 'utf8') : undefined };
    });
    const workItems = captureCatalogData(readWorkItems());
    const fingerprint = manager?.fingerprint?.();
    let sessionList: ReturnType<typeof readSessionList>, sessions: ReturnType<typeof readSessionBodies>;
    if (reuseSessions && fingerprint !== undefined && sessionReading?.fingerprint === fingerprint) {
      ({ sessionList, sessions } = sessionReading);
    } else {
      sessionList = readSessionList();
      sessions = readSessionBodies(sessionList);
      sessionReading = fingerprint === undefined ? undefined : { fingerprint, sessionList, sessions };
    }
    const vibe = shellPaths ? captureCatalogData(discoverVibeFiles(shellPaths)) : undefined;
    const vibeEvidence = vibe ? [...vibe.files, ...vibe.blocked].map(file => ({ ...file, body: fs.readFileSync(file.path, 'utf8') })) : [];
    assertNative();
    return captureCatalogData({ capturedAt, memoryRecords, noteSnapshot, personaSnapshot, skillSnapshot, routineSnapshot, researchSnapshot, registryFiles, workItems, sessionList, sessions, vibe, vibeEvidence });
  };
  assertCaller();
  const source = read();
  assertCaller();
  // Keep the complete raw source for native currentness and exact self-write proofs.
  // These columns belong to records acquired through the retained Memory API.
  // Preserve every other slot, including nested producer evidence. `source` is
  // already a captured plain copy, so its slots are read directly.
  const projectMemoryRecord = (record: unknown): unknown => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new ToolInputProjectionError('invalid');
    const projected: Record<string, unknown> = Object.create(null);
    for (const [key, original] of Object.entries(record)) {
      let value: unknown = original;
      if (['createdAt', 'updatedAt', 'reviewedAt', 'validFrom', 'validUntil'].includes(key) && typeof value === 'number') {
        if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
        value = new Date(value).toISOString();
      }
      projected[key] = value;
    }
    return projected;
  };
  const memoryReadingRecords: unknown[] = source.memoryRecords.map(projectMemoryRecord);
  const replaceSlots = <T extends object, R extends Record<string, unknown>>(record: T, replacements: R): Omit<T, keyof R> & R =>
    ({ ...record, ...replacements }) as Omit<T, keyof R> & R;
  const nativeClock = (value: unknown): string => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
    return new Date(value).toISOString();
  };
  const projectSessionMeta = <T extends { readonly timestamp?: number }>(record: T): Omit<T, 'timestamp'> & { readonly timestamp?: string | undefined } => {
    if (record.timestamp === undefined) return record as Omit<T, 'timestamp'>;
    return replaceSlots(record, { timestamp: nativeClock(record.timestamp) });
  };
  const projectCollection = <T, R>(records: readonly T[], project: (record: T) => R): readonly R[] => records.map(record => project(record));
  // Only metadata acquired from this retained SessionManager owns these clock
  // slots. Keep hidden collection/record evidence and every original byte locally.
  const sessionList = projectCollection(source.sessionList, projectSessionMeta);
  const sessions = projectCollection(source.sessions, record => replaceSlots(record, {
    session: projectSessionMeta(record.session),
    loaded: record.loaded ? replaceSlots(record.loaded, { meta: projectSessionMeta(record.loaded.meta) }) : record.loaded,
  }));
  const workItems = projectCollection(source.workItems, record => replaceSlots(record, {
    createdAt: nativeClock(record.createdAt), updatedAt: nativeClock(record.updatedAt),
    ...(Object.hasOwn(record, 'completedAt') ? { completedAt: record.completedAt === undefined ? undefined : nativeClock(record.completedAt) } : {}),
  }));
  const readingSource = captureCatalogData({ ...source, workItems, capturedAt: capturedAtForReading, memoryRecords: memoryReadingRecords, sessionList, sessions });
  const assertReadingSnapshot = captureModelReadingSnapshotGuard(readingSource);
  let expected = source;
  let assertSnapshot = captureModelReadingSnapshotGuard(expected);
  let active: object | undefined;
  const checkEvidence = (full: boolean) => { assertReadingBackends(); assertSnapshot(read(!full)); assertReadingSnapshot(readingSource); assertNative(); };
  const assertEvidence = () => checkEvidence(false);
  const assertCurrent = () => {
    assertCaller(); assertEvidence(); assertCaller(); assertEvidence();
  };
  // Before anything is published every source is read again, session files included.
  const assertCurrentFully = () => {
    assertCaller(); checkEvidence(true); assertCaller(); checkEvidence(true);
  };
  assertCurrent();
  const originalRecord = (state: typeof source, domain: LocalLearningCandidateDomain, id: string): unknown => {
    const records = domain === 'memory' ? state.memoryRecords : domain === 'note' ? state.noteSnapshot?.notes
      : domain === 'persona' ? state.personaSnapshot?.personas : domain === 'skill' ? state.skillSnapshot?.skills
        : domain === 'skill_bundle' ? state.skillSnapshot?.bundles : state.routineSnapshot?.routines;
    return records?.find(record => record.id === id);
  };
  const assertOriginalRecords = (domain: LocalLearningCandidateDomain, ids: readonly string[]) => {
    assertCurrent();
    for (const id of ids) {
      const original = originalRecord(source, domain, id), current = originalRecord(expected, domain, id);
      if (!original || !current) throw new ToolInputProjectionError('held');
      captureCatalogSnapshotGuard(original)(current);
    }
    assertCurrent();
  };
  const prepareTransition = (_intent: LearningTransitionIntent): LearningSourceTransition => {
    assertCurrent();
    if (active) throw new ToolInputProjectionError('held');
    const lease = {};
    active = lease;
    let phase: 'unpublished' | 'published' | 'finished' = 'unpublished';
    const assertLease = () => {
      assertCaller(); assertReadingBackends();
      if (active !== lease || phase === 'finished') throw new ToolInputProjectionError('held');
    };
    const effects = Object.freeze({
      assertCurrent: () => { assertLease(); if (phase !== 'unpublished') throw new ToolInputProjectionError('held'); assertCurrentFully(); },
      onEffect: (published?: boolean) => {
        assertLease();
        if (published !== true) { if (phase !== 'unpublished') throw new ToolInputProjectionError('held'); assertCurrentFully(); return; }
        if (phase !== 'unpublished') throw new ToolInputProjectionError('held');
        phase = 'published';
      },
    });
    return Object.freeze({ effects,
      // The registry is the one owner of its record and file format: the curator
      // does not predict its bytes, it adopts what the registry wrote.
      commit: (_record: unknown) => {
        assertLease();
        if (phase !== 'published') throw new ToolInputProjectionError('held');
        expected = read();
        assertSnapshot = captureModelReadingSnapshotGuard(expected);
        phase = 'finished'; active = undefined;
        assertCaller();
      },
      abort: () => {
        if (phase === 'finished') return;
        if (active !== lease) throw new ToolInputProjectionError('held');
        phase = 'finished'; active = undefined;
      },
    });
  };
  if (retainCurrent) {
    synchronous(() => retainCurrent(assertEvidence, 'agent.learning.curator.native-source')); assertCaller();
  }
  const libraries: Readonly<Record<LocalLearningCandidateDomain, readonly LearningRecord[]>> = {
    memory: source.memoryRecords.map((record, index) => ({ item: summarizeMemoryItem(record), record: readingSource.memoryRecords[index] })),
    note: (source.noteSnapshot?.notes ?? []).map(record => ({ item: summarizeNoteItem(record), record })),
    persona: (source.personaSnapshot?.personas ?? []).map(record => ({ item: summarizePersonaItem(record, source.personaSnapshot?.activePersonaId ?? null), record })),
    skill: (source.skillSnapshot?.skills ?? []).map(record => ({ item: summarizeSkillItem(record), record })),
    skill_bundle: (source.skillSnapshot?.bundles ?? []).map(record => ({ item: summarizeSkillBundleItem(record, source.skillSnapshot?.skills ?? []), record })),
    routine: (source.routineSnapshot?.routines ?? []).map(record => ({ item: summarizeRoutineItem(record), record })),
  };
  for (const records of Object.values(libraries)) {
    const ids = records.map(record => record.item.id);
    if (new Set(ids).size !== ids.length) throw new ToolInputProjectionError('held');
  }
  const retainReadingCurrent = (guard: () => void, key?: string) => {
    assertCurrent();
    retained.add(guard);
    if (retainCurrent) synchronous(() => retainCurrent(guard, key));
    assertCurrent();
  };
  const scoped = Object.freeze({ ...options, assertCurrent, retainCurrent: retainReadingCurrent, requirePreservedSource: true });
  return { source: readingSource, libraries, assertCurrent, assertOriginalRecords, prepareTransition, options: scoped };
}

export type LearningCuratorSource = ReturnType<typeof acquireLearningCuratorSource>;
export interface LearningCandidateCollection {
  readonly candidates: readonly LearningCandidate[];
  readonly promptRecords: readonly { readonly domain: LocalLearningCandidateDomain; readonly item: AgentWorkspaceLocalLibraryItem; readonly priority: LearningCandidate['priority']; readonly scores: LearningCandidate['scores'] }[];
  readonly assertCurrent: () => void;
  readonly options: CatalogRankingOptions;
  readonly assertCandidateCurrent: (candidate: LearningCandidate) => void;
  readonly prepareTransition: (intent: LearningTransitionIntent) => LearningSourceTransition;
}
