import { freshReviewPatch, parseAgentReviewState, reviewedReviewPatch, staleReviewPatch } from './review-state.js';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { readJsonStore, writeJsonStore, type JsonStoreContents, type JsonStoreSpec, type JsonStoreWriteReport, type writeStoreFile } from './store-file.js';
import { storeFileChangeStamp } from './store-change-stamp.js';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { assertNoSecretLikeText, runLockedStoreUpdate } from './persona-registry.js';
import { formatAgentRecordReviewState } from './record-labels.js';
import {
  evaluateAgentSkillReadiness,
  formatAgentSkillRequirement,
  normalizeAgentSkillRequirements,
  type AgentSkillReadiness,
  type AgentSkillRequirement,
} from './skill-registry.js';

export type AgentRoutineSource = 'user' | 'agent' | 'imported' | 'system';
export type AgentRoutineReviewState = 'fresh' | 'reviewed' | 'stale';
export type AgentRoutineRequirement = AgentSkillRequirement;
export type AgentRoutineReadiness = AgentSkillReadiness;

export interface AgentRoutineRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: string;
  readonly triggers: readonly string[];
  readonly tags: readonly string[];
  readonly requirements: readonly AgentRoutineRequirement[];
  readonly enabled: boolean;
  readonly source: AgentRoutineSource;
  readonly provenance: string;
  readonly reviewState: AgentRoutineReviewState;
  readonly staleReason?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string | undefined;
  readonly lastStartedAt?: string | undefined;
  readonly startCount: number;
}

export interface AgentRoutineCreateInput {
  readonly name: string;
  readonly description: string;
  readonly steps: string;
  readonly triggers?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly requirements?: readonly AgentRoutineRequirement[] | undefined;
  readonly enabled?: boolean | undefined;
  readonly source?: AgentRoutineSource | undefined;
  readonly provenance?: string | undefined;
}

export interface AgentRoutineUpdateInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly steps?: string | undefined;
  readonly triggers?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly requirements?: readonly AgentRoutineRequirement[] | undefined;
  /** Applied in the same write as the field edit. */
  readonly enabled?: boolean | undefined;
  readonly provenance?: string | undefined;
}

export interface AgentRoutineSnapshot {
  readonly path: string;
  readonly routines: readonly AgentRoutineRecord[];
  readonly enabledRoutines: readonly AgentRoutineRecord[];
}

interface RoutineStoreFile {
  readonly version: 1;
  readonly routines: readonly AgentRoutineRecord[];
}

const STORE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function readRequirementArray(value: unknown): readonly AgentRoutineRequirement[] {
  if (!Array.isArray(value)) return [];
  const requirements = value
    .filter(isRecord)
    .map((entry) => ({
      kind: entry.kind === 'command' ? 'command' as const : 'env' as const,
      name: readString(entry.name).trim(),
      description: readString(entry.description).trim() || undefined,
    }));
  return normalizeAgentSkillRequirements(requirements);
}

function readNonNegativeInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function normalizeList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'routine';
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseRoutine(value: unknown): AgentRoutineRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const name = normalizeName(readString(value.name));
  const description = readString(value.description).trim();
  const steps = readString(value.steps).trim();
  if (!id || !name || !description || !steps) return null;
  const reviewState = parseAgentReviewState(value.reviewState);
  const source = value.source === 'agent' || value.source === 'imported' || value.source === 'system' ? value.source : 'user';
  const staleReason = readString(value.staleReason).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  const lastStartedAt = readString(value.lastStartedAt).trim();
  return {
    id,
    name,
    description,
    steps,
    triggers: readStringArray(value.triggers),
    tags: readStringArray(value.tags),
    requirements: readRequirementArray(value.requirements),
    enabled: value.enabled === true,
    source,
    provenance: readString(value.provenance, source).trim() || source,
    reviewState,
    staleReason: staleReason || undefined,
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
    reviewedAt: reviewedAt || undefined,
    lastStartedAt: lastStartedAt || undefined,
    startCount: readNonNegativeInteger(value.startCount),
  };
}

const ROUTINE_STORE: JsonStoreSpec<AgentRoutineRecord> = {
  label: 'routine store',
  entriesKey: 'routines',
  version: STORE_VERSION,
  parseEntry: parseRoutine,
};

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function routineStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'routines', 'routines.json');
}

export class AgentRoutineRegistry {
  private held: JsonStoreContents<AgentRoutineRecord> | null = null;
  private lastWrite: JsonStoreWriteReport | undefined;

  public constructor(private readonly storePath: string, private readonly effects?: Parameters<typeof writeStoreFile>[2]) {}

  public static fromShellPaths(shellPaths: AgentLocalStorePaths, effects?: Parameters<typeof writeStoreFile>[2]): AgentRoutineRegistry {
    return new AgentRoutineRegistry(routineStorePath(shellPaths), effects);
  }

  /** Changes whenever the routine store is written, by this process or another; one stat. */
  public changeStamp(): string {
    return storeFileChangeStamp(this.storePath);
  }

  public snapshot(): AgentRoutineSnapshot {
    const store = this.readStore();
    return {
      path: this.storePath,
      routines: [...store.routines],
      enabledRoutines: store.routines.filter((routine) => routine.enabled),
    };
  }

  public list(): readonly AgentRoutineRecord[] {
    return this.snapshot().routines;
  }

  public search(query: string): readonly AgentRoutineRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((routine) => [
      routine.id,
      routine.name,
      routine.description,
      routine.steps,
      ...routine.tags,
      ...routine.triggers,
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrName: string): AgentRoutineRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((routine) => routine.id.toLowerCase() === lookup || routine.name.toLowerCase() === lookup) ?? null;
  }

  /**
   * `reviewed`: trusted callers only, for text shipped in this build (a
   * built-in profile starter); everything else starts fresh and waits for review.
   */
  public create(input: AgentRoutineCreateInput, options: { readonly reviewed?: boolean } = {}): AgentRoutineRecord {
    return this.locked(() => {
      const store = this.readStore();
      const name = normalizeName(input.name);
      const description = input.description.trim();
      const steps = input.steps.trim();
      this.validateRequired(name, description, steps);
      const requirements = normalizeAgentSkillRequirements(input.requirements);
      assertNoSecretLikeText([name, description, steps, ...(input.tags ?? []), ...(input.triggers ?? []), ...requirements.flatMap((requirement) => [requirement.name, requirement.description ?? ''])], 'Routines');
      const duplicate = store.routines.find((routine) => routine.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Routine already exists ${duplicate.id}`);
      const timestamp = nowIso();
      const routine: AgentRoutineRecord = {
        id: this.nextId(name, store.routines),
        name,
        description,
        steps,
        triggers: normalizeList(input.triggers),
        tags: normalizeList(input.tags),
        requirements,
        enabled: input.enabled === true,
        source: input.source ?? 'user',
        provenance: input.provenance?.trim() || input.source || 'user',
        ...(options.reviewed ? reviewedReviewPatch() : { reviewState: 'fresh' as const }),
        createdAt: timestamp,
        updatedAt: timestamp,
        startCount: 0,
      };
      this.writeStore({ ...store, routines: [...store.routines, routine] });
      return routine;
    });
  }

  public update(idOrName: string, input: AgentRoutineUpdateInput): AgentRoutineRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown routine ${idOrName}`);
      const name = input.name === undefined ? existing.name : normalizeName(input.name);
      const description = input.description === undefined ? existing.description : input.description.trim();
      const steps = input.steps === undefined ? existing.steps : input.steps.trim();
      this.validateRequired(name, description, steps);
      const requirements = input.requirements === undefined ? existing.requirements : normalizeAgentSkillRequirements(input.requirements);
      assertNoSecretLikeText([name, description, steps, ...(input.tags ?? []), ...(input.triggers ?? []), ...requirements.flatMap((requirement) => [requirement.name, requirement.description ?? ''])], 'Routines');
      const duplicate = store.routines.find((routine) => routine.id !== existing.id && routine.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Routine already exists ${duplicate.id}`);
      const updated: AgentRoutineRecord = {
        ...existing,
        name,
        description,
        steps,
        triggers: input.triggers === undefined ? existing.triggers : normalizeList(input.triggers),
        tags: input.tags === undefined ? existing.tags : normalizeList(input.tags),
        requirements,
        enabled: input.enabled ?? existing.enabled,
        provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
        ...freshReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        routines: store.routines.map((routine) => routine.id === existing.id ? updated : routine),
      });
      return updated;
    });
  }

  public setEnabled(idOrName: string, enabled: boolean): AgentRoutineRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown routine ${idOrName}`);
      const updated: AgentRoutineRecord = { ...existing, enabled, updatedAt: nowIso() };
      this.writeStore({
        ...store,
        routines: store.routines.map((routine) => routine.id === existing.id ? updated : routine),
      });
      return updated;
    });
  }

  public markStarted(idOrName: string): AgentRoutineRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown routine ${idOrName}`);
      const timestamp = nowIso();
      const updated: AgentRoutineRecord = {
        ...existing,
        lastStartedAt: timestamp,
        startCount: existing.startCount + 1,
        updatedAt: timestamp,
      };
      this.writeStore({
        ...store,
        routines: store.routines.map((routine) => routine.id === existing.id ? updated : routine),
      });
      return updated;
    });
  }

  public markReviewed(idOrName: string): AgentRoutineRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown routine ${idOrName}`);
      const updated: AgentRoutineRecord = {
        ...existing,
        ...reviewedReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        routines: store.routines.map((routine) => routine.id === existing.id ? updated : routine),
      });
      return updated;
    });
  }

  public markStale(idOrName: string, reason: string): AgentRoutineRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown routine ${idOrName}`);
      const updated: AgentRoutineRecord = {
        ...existing,
        ...staleReviewPatch(reason),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        routines: store.routines.map((routine) => routine.id === existing.id ? updated : routine),
      });
      return updated;
    });
  }

  public deleteRoutine(idOrName: string): AgentRoutineRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown routine ${idOrName}`);
      this.writeStore({
        ...store,
        routines: store.routines.filter((routine) => routine.id !== existing.id),
      });
      return existing;
    });
  }

  private validateRequired(name: string, description: string, steps: string): void {
    if (!name) throw new Error('Routine name is required.');
    if (!description) throw new Error('Routine description is required.');
    if (!steps) throw new Error('Routine steps are required.');
  }

  private nextId(name: string, routines: readonly AgentRoutineRecord[]): string {
    const base = slugify(name);
    const ids = new Set(routines.map((routine) => routine.id));
    if (!ids.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate routine id for ${name}.`);
  }

  private findInStore(store: RoutineStoreFile, idOrName: string): AgentRoutineRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return store.routines.find((routine) => routine.id.toLowerCase() === lookup || routine.name.toLowerCase() === lookup) ?? null;
  }

  /** What the last write reported: routines this version cannot read that were kept, or a copy of an unreadable file. */
  public lastWriteReport(): JsonStoreWriteReport | undefined {
    return this.lastWrite;
  }

  /** A file that is not JSON is reported on a read, never shown as no routines; a save copies it aside first. */
  private readStore(): RoutineStoreFile {
    const contents = this.held ?? readJsonStore(this.storePath, ROUTINE_STORE);
    if (!this.held && contents.unreadable !== undefined) {
      throw new Error(`Could not read Agent routine store at ${this.storePath}: it is ${contents.unreadable}. Repair the file, or save a routine to copy it aside and start a fresh store.`);
    }
    return { version: STORE_VERSION, routines: contents.entries };
  }

  /** One locked read-modify-write; the file is read once and entries this version cannot read are written back as found. */
  private locked<T>(update: () => T): T {
    return runLockedStoreUpdate(this.storePath, this.effects, () => {
      this.held = readJsonStore(this.storePath, ROUTINE_STORE);
      try {
        return update();
      } finally {
        this.held = null;
      }
    });
  }

  private writeStore(store: RoutineStoreFile): void {
    const read = this.held ?? readJsonStore(this.storePath, ROUTINE_STORE);
    this.lastWrite = writeJsonStore(read, ROUTINE_STORE, { entries: store.routines }, this.effects);
  }
}

export function evaluateAgentRoutineReadiness(
  routine: Pick<AgentRoutineRecord, 'requirements'>,
  options: Parameters<typeof evaluateAgentSkillReadiness>[1] = {},
): AgentRoutineReadiness {
  return evaluateAgentSkillReadiness(routine, options);
}

/** How many reviewed, ready routines one prompt carries; the receipt counts against the same number. */
export const ENABLED_ROUTINES_PROMPT_LIMIT = 8;

export function buildEnabledRoutinesPrompt(shellPaths: ShellPathService, snapshot?: AgentRoutineSnapshot): string | null {
  const enabledRecords = (snapshot ?? AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot()).enabledRoutines;
  const enabled = enabledRecords.filter((routine) => routine.reviewState === 'reviewed' && evaluateAgentRoutineReadiness(routine).ready);
  const suppressed = enabledRecords
    .filter((routine) => !enabled.some((activeRoutine) => activeRoutine.id === routine.id))
    .slice(0, ENABLED_ROUTINES_PROMPT_LIMIT)
    .map((routine) => {
      const readiness = evaluateAgentRoutineReadiness(routine);
      const review = routine.reviewState === 'reviewed' ? '' : `review=${formatAgentRecordReviewState(routine.reviewState)}`;
      const setup = readiness.ready ? '' : `missing=${readiness.missing.map(formatAgentSkillRequirement).join(', ')}`;
      return `- ${routine.name}: ${[review, setup].filter(Boolean).join('; ')}`;
    });
  if (enabled.length === 0 && suppressed.length === 0) return null;
  return [
    '## Enabled GoodVibes Agent Routines',
    'Use only reviewed, setup-ready local reusable routines inside the same serial assistant conversation when they fit the user request. Do not start hidden background jobs because a routine matches.',
    '',
    ...enabled.slice(0, ENABLED_ROUTINES_PROMPT_LIMIT).flatMap((routine) => [
      `### ${routine.name}`,
      `Description: ${routine.description}`,
      `Review: ${formatAgentRecordReviewState(routine.reviewState)}`,
      `Triggers: ${routine.triggers.join(', ') || '(manual)'}`,
      `Readiness: ${evaluateAgentRoutineReadiness(routine).ready ? 'ready' : `missing ${evaluateAgentRoutineReadiness(routine).missing.map(formatAgentSkillRequirement).join(', ')}`}`,
      routine.steps,
      '',
    ]),
    ...(suppressed.length > 0 ? [
      '### Suppressed Routines Pending Review Or Setup',
      'Do not apply these routines until the user reviews them or resolves setup through the learning curator.',
      ...suppressed,
      '',
    ] : []),
  ].join('\n').trim();
}
