import type { MemoryAddOptions } from '@goodvibes-jev/engine/platform/platform/state';
import type { AgentPersonaCreateInput, AgentPersonaUpdateInput } from './persona-registry.js';
import type { AgentSkillCreateInput, AgentSkillUpdateInput } from './skill-registry.js';
import type { AgentRoutineCreateInput, AgentRoutineUpdateInput } from './routine-registry.js';
import { AgentNoteRegistry } from './note-registry.js';
import { AgentPersonaRegistry } from './persona-registry.js';
import { AgentSkillRegistry } from './skill-registry.js';
import { AgentRoutineRegistry } from './routine-registry.js';
import { AgentResearchRunRegistry } from './research-run-registry.js';
import { summarizeMemoryItem, summarizeNoteItem, summarizePersonaItem, summarizeSkillItem, summarizeSkillBundleItem, summarizeRoutineItem } from './local-library-items.js';
import type { AgentWorkspaceLocalLibraryItem } from './local-library-items.js';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { MemoryApi, ProjectWorkPlan, ProjectWorkPlanTask } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData } from './catalog-data.js';
import type { CatalogRankingOptions } from './catalog-ranking.js';
import { discoverVibeFiles } from './vibe-file.js';
import type { LocalLearningCandidateDomain, LearningCandidate } from './learning-curator-types.js';
import { LearningCurationStore } from './learning-curation-store.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';

/** A work-plan task as the curator reads it: the row's fields under the record id the readings use. */
export interface LearningWorkItem {
  readonly id: string;
  readonly title: string;
  readonly status: ProjectWorkPlanTask['status'];
  readonly owner?: string | undefined;
  readonly source?: string | undefined;
  readonly notes?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
}

function nativeClock(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
  return new Date(value).toISOString();
}

function learningWorkItem(task: ProjectWorkPlanTask): LearningWorkItem {
  return {
    id: task.taskId,
    title: task.title,
    status: task.status,
    ...(task.owner ? { owner: task.owner } : {}),
    ...(task.source ? { source: task.source } : {}),
    ...(task.notes ? { notes: task.notes } : {}),
    createdAt: nativeClock(task.createdAt),
    updatedAt: nativeClock(task.updatedAt),
    ...(task.completedAt !== undefined ? { completedAt: nativeClock(task.completedAt) } : {}),
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
  /** After the registry's own write; the registry owns the record and its file format. */
  readonly commit: (record: unknown) => void;
  readonly abort: () => void;
}

export interface LearningRecord {
  readonly item: AgentWorkspaceLocalLibraryItem;
  readonly record: unknown;
}

/**
 * What the curator reads from the turn it runs in: the Agent's command context
 * in its own process, or a session the daemon hosts for the Agent (shell
 * paths and memory only; no work plan or saved-session list there).
 */
export interface LearningCuratorNativeContext {
  readonly workspace?: { readonly shellPaths: ShellPathService; readonly workPlan?: Pick<ProjectWorkPlan, 'snapshotNow'> | undefined } | undefined;
  readonly clients?: { readonly agentKnowledgeApi?: { readonly memory?: Pick<MemoryApi, 'getAll'> | undefined } | undefined } | undefined;
  readonly session?: {
    readonly sessionManager?: Pick<SessionManager, 'list' | 'load'> | undefined;
    readonly runtime?: { readonly sessionId: string } | undefined;
  } | undefined;
}

type SessionListEntry = ReturnType<NonNullable<NonNullable<LearningCuratorNativeContext['session']>['sessionManager']>['list']>[number];
type SessionMeta = Omit<SessionListEntry, 'timestamp'> & { readonly timestamp?: string | undefined };
type LoadedSession = NonNullable<ReturnType<NonNullable<NonNullable<LearningCuratorNativeContext['session']>['sessionManager']>['load']>>;
export interface LearningSessionRecord {
  readonly session: SessionMeta;
  readonly loaded: (Omit<LoadedSession, 'meta'> & { readonly meta: SessionMeta }) | undefined;
}

function projectSessionMeta<T extends { readonly timestamp?: number }>(record: T): Omit<T, 'timestamp'> & { readonly timestamp?: string | undefined } {
  if (record.timestamp === undefined) return record as Omit<T, 'timestamp'>;
  return ({ ...record, timestamp: nativeClock(record.timestamp) }) as Omit<T, 'timestamp'> & { readonly timestamp?: string | undefined };
}

/** Memory clock columns as ISO text, so a reading sees dates rather than epoch numbers. */
function projectMemoryRecord(record: unknown): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new ToolInputProjectionError('invalid');
  const projected: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    projected[key] = ['createdAt', 'updatedAt', 'reviewedAt', 'validFrom', 'validUntil'].includes(key) && typeof value === 'number' ? nativeClock(value) : value;
  }
  return projected;
}

/**
 * One read of every learning store for one call: memory, notes, personas,
 * skills, routines, research runs, the work plan, the saved-session list and
 * VIBE health. Session transcripts are not loaded here; `loadSession` reads
 * one when a caller needs it. Nothing is read again to prove it did not
 * change: the call's own check (signal and admission) is the only currentness
 * test, and a listing a moment old is corrected by the next call.
 */
export function acquireLearningCuratorSource(context: LearningCuratorNativeContext, options: CatalogRankingOptions) {
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (callerCurrent) assertSynchronousJudgmentGuard(callerCurrent, () => new ToolInputProjectionError('held'));
    signal?.throwIfAborted();
  };
  assertCurrent();
  const memory = context.clients?.agentKnowledgeApi?.memory;
  const manager = context.session?.sessionManager;
  const sessionId = context.session?.runtime?.sessionId;
  const shellPaths = context.workspace?.shellPaths;
  const capturedAt = new Date().toISOString();
  const memoryRecords = captureCatalogData(memory?.getAll() ?? []);
  const noteSnapshot = shellPaths ? captureCatalogData(AgentNoteRegistry.fromShellPaths(shellPaths).snapshot()) : undefined;
  const personaSnapshot = shellPaths ? captureCatalogData(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot()) : undefined;
  const skillSnapshot = shellPaths ? captureCatalogData(AgentSkillRegistry.fromShellPaths(shellPaths).snapshot()) : undefined;
  const routineSnapshot = shellPaths ? captureCatalogData(AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot()) : undefined;
  const researchSnapshot = shellPaths ? captureCatalogData(AgentResearchRunRegistry.fromShellPaths(shellPaths).snapshot()) : undefined;
  const workItems = captureCatalogData((context.workspace?.workPlan?.snapshotNow().tasks ?? []).map(learningWorkItem));
  const sessions: readonly SessionMeta[] = captureCatalogData(manager?.list() ?? []).filter(session => session.name !== sessionId).map(projectSessionMeta);
  const vibe = shellPaths ? captureCatalogData(discoverVibeFiles(shellPaths)) : undefined;
  const source = Object.freeze({ capturedAt, workItems, researchSnapshot, sessions, vibe });
  const loadSession = (session: SessionMeta): LearningSessionRecord => {
    assertCurrent();
    const loaded = manager ? captureCatalogData(manager.load(session.name)) : undefined;
    return { session, loaded: loaded ? { ...loaded, meta: projectSessionMeta(loaded.meta) } : undefined };
  };
  let active: object | undefined;
  // One registry write at a time per acquired source; the registry is the owner of the record it writes.
  const prepareTransition = (_intent: LearningTransitionIntent): LearningSourceTransition => {
    assertCurrent();
    if (active) throw new ToolInputProjectionError('held');
    const lease = {};
    active = lease;
    let phase: 'unpublished' | 'published' | 'finished' = 'unpublished';
    const assertLease = () => {
      assertCurrent();
      if (active !== lease || phase === 'finished') throw new ToolInputProjectionError('held');
    };
    const effects = Object.freeze({
      assertCurrent: () => { assertLease(); if (phase !== 'unpublished') throw new ToolInputProjectionError('held'); },
      onEffect: (published?: boolean) => {
        assertLease();
        if (phase !== 'unpublished') throw new ToolInputProjectionError('held');
        if (published === true) phase = 'published';
      },
    });
    return Object.freeze({ effects,
      commit: (_record: unknown) => {
        if (active !== lease || phase !== 'published') throw new ToolInputProjectionError('held');
        phase = 'finished'; active = undefined;
      },
      abort: () => {
        if (phase === 'finished') return;
        if (active !== lease) throw new ToolInputProjectionError('held');
        phase = 'finished'; active = undefined;
      },
    });
  };
  const libraries: Readonly<Record<LocalLearningCandidateDomain, readonly LearningRecord[]>> = {
    memory: memoryRecords.map(record => ({ item: summarizeMemoryItem(record), record: projectMemoryRecord(record) })),
    note: (noteSnapshot?.notes ?? []).map(record => ({ item: summarizeNoteItem(record), record })),
    persona: (personaSnapshot?.personas ?? []).map(record => ({ item: summarizePersonaItem(record, personaSnapshot?.activePersonaId ?? null), record })),
    skill: (skillSnapshot?.skills ?? []).map(record => ({ item: summarizeSkillItem(record), record })),
    skill_bundle: (skillSnapshot?.bundles ?? []).map(record => ({ item: summarizeSkillBundleItem(record, skillSnapshot?.skills ?? []), record })),
    routine: (routineSnapshot?.routines ?? []).map(record => ({ item: summarizeRoutineItem(record), record })),
  };
  const curation = LearningCurationStore.forPaths(shellPaths);
  const scoped = Object.freeze({ ...options, assertCurrent, requirePreservedSource: true });
  return { source, libraries, curation, loadSession, assertCurrent, prepareTransition, options: scoped };
}

export type LearningCuratorSource = ReturnType<typeof acquireLearningCuratorSource>;
export interface LearningCandidateCollection {
  readonly candidates: readonly LearningCandidate[];
  readonly promptRecords: readonly { readonly domain: LocalLearningCandidateDomain; readonly item: AgentWorkspaceLocalLibraryItem; readonly priority: LearningCandidate['priority']; readonly scores: LearningCandidate['scores'] }[];
  /** Records no curation pass has read yet in their current form; `memory action:"curate"` reads them. */
  readonly unassessed: number;
  readonly lastCurationPassAt: number | null;
  readonly assertCurrent: () => void;
  readonly options: CatalogRankingOptions;
  readonly assertCandidateCurrent: (candidate: LearningCandidate) => void;
  readonly prepareTransition: (intent: LearningTransitionIntent) => LearningSourceTransition;
}
