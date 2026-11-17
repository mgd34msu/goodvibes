import { createHash } from 'node:crypto';
import { readDocument, writeDocument, logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import type { LearningProposalTarget, LearningScores } from './learning-curator-types.js';

/**
 * What the learning curation pass already settled, so the curator's overview,
 * candidate lookups and promotions read stored verdicts instead of asking a
 * model again. Every verdict carries the content hash of what it was read
 * from; a verdict whose hash no longer matches the record is simply not used,
 * and the next pass reads that record again. The document is held in memory
 * by its owner (one per store path per process) and written whole on a real
 * change.
 */

export interface StoredLearningGrade {
  readonly scores: LearningScores;
  readonly priority: number;
  readonly confidence: number;
}

export interface StoredLearningProposal {
  readonly target: LearningProposalTarget | null;
  /** Memory class read for a memory proposal. */
  readonly cls?: string | undefined;
}

interface Verdict<T> { readonly hash: string; readonly value: T }

interface LearningCurationDocument {
  readonly version: 1;
  lastPassAt: number | null;
  proposals: Record<string, Verdict<StoredLearningProposal>>;
  pairs: Record<string, Verdict<boolean>>;
  survivors: Record<string, Verdict<string>>;
  grades: Record<string, Verdict<StoredLearningGrade>>;
}

type Section = 'proposals' | 'pairs' | 'survivors' | 'grades';

function emptyDocument(): LearningCurationDocument {
  return { version: 1, lastPassAt: null, proposals: {}, pairs: {}, survivors: {}, grades: {} };
}

/**
 * Record fields that change without changing what the record says: review and
 * stale bookkeeping, enable/active switches, run counters and update times. A
 * verdict survives them, so staging a duplicate stale keeps its group for the
 * delete phase, and starting a routine does not send it back to the model.
 */
const BOOKKEEPING_FIELDS = new Set(['reviewState', 'reviewedAt', 'reviewedBy', 'staleReason', 'updatedAt', 'confidence',
  'enabled', 'active', 'lastStartedAt', 'startCount', 'promoted', 'validFrom', 'validUntil']);

/** Key-order independent JSON, so the same record read through two stores hashes alike. */
function canonical(value: unknown, top: boolean): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonical(entry, false)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(key => !(top && BOOKKEEPING_FIELDS.has(key))).sort();
    const record = value as Record<string, unknown>;
    return `{${keys.filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(record[key], false)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A short stable hash of what a record says (its bookkeeping fields left out). */
export function learningContentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value, true)).digest('base64url').slice(0, 22);
}

function validate(parsed: unknown): LearningCurationDocument {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Learning curation document is not an object.');
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) throw new Error('Learning curation document has an unknown version.');
  const section = (key: Section): Record<string, Verdict<never>> => {
    const value = record[key];
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Learning curation ${key} is not an object.`);
    return value as Record<string, Verdict<never>>;
  };
  const lastPassAt = typeof record.lastPassAt === 'number' && Number.isFinite(record.lastPassAt) ? record.lastPassAt : null;
  return { version: 1, lastPassAt, proposals: section('proposals'), pairs: section('pairs'), survivors: section('survivors'), grades: section('grades') };
}

export class LearningCurationStore {
  #document: LearningCurationDocument;
  #dirty = false;

  private constructor(private readonly path: string | undefined, document: LearningCurationDocument) {
    this.#document = document;
  }

  static #owners = new Map<string, LearningCurationStore>();

  /** The one owner of the curation document under these paths; an in-memory store when there is no workspace. */
  static forPaths(paths: Pick<ShellPathService, 'resolveUserPath'> | undefined): LearningCurationStore {
    if (!paths) return new LearningCurationStore(undefined, emptyDocument());
    const path = paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'learning-curation.json');
    const owned = LearningCurationStore.#owners.get(path);
    if (owned) return owned;
    let document = emptyDocument();
    try {
      document = readDocument(path, {
        label: 'agent/learning-curation', validate,
        recovery: 'The learning curator starts with no stored verdicts; the next memory action:"curate" pass reads the records again.',
      }) ?? emptyDocument();
    } catch (error) {
      logger.warn('Learning curation verdicts could not be read; starting without them', { error: summarizeError(error) });
    }
    const store = new LearningCurationStore(path, document);
    LearningCurationStore.#owners.set(path, store);
    return store;
  }

  get lastPassAt(): number | null { return this.#document.lastPassAt; }

  #get(section: Section, key: string, hash: string): unknown {
    const verdict: Verdict<unknown> | undefined = this.#document[section][key];
    return verdict && verdict.hash === hash ? verdict.value : undefined;
  }

  #set(section: Section, key: string, hash: string, value: unknown): void {
    const entries: Record<string, Verdict<unknown>> = this.#document[section];
    const previous = entries[key];
    if (previous && previous.hash === hash && JSON.stringify(previous.value) === JSON.stringify(value)) return;
    entries[key] = { hash, value };
    this.#dirty = true;
  }

  proposal(key: string, hash: string): StoredLearningProposal | undefined { return this.#get('proposals', key, hash) as StoredLearningProposal | undefined; }
  setProposal(key: string, hash: string, value: StoredLearningProposal): void { this.#set('proposals', key, hash, value); }
  pair(key: string, hash: string): boolean | undefined { return this.#get('pairs', key, hash) as boolean | undefined; }
  setPair(key: string, hash: string, same: boolean): void { this.#set('pairs', key, hash, same); }
  survivor(key: string, hash: string): string | undefined { return this.#get('survivors', key, hash) as string | undefined; }
  setSurvivor(key: string, hash: string, id: string): void { this.#set('survivors', key, hash, id); }
  grade(key: string, hash: string): StoredLearningGrade | undefined { return this.#get('grades', key, hash) as StoredLearningGrade | undefined; }
  setGrade(key: string, hash: string, value: StoredLearningGrade): void { this.#set('grades', key, hash, value); }

  /** Drops verdicts for keys the pass no longer saw, so the document stays the size of what exists. */
  retainOnly(live: Readonly<Record<Section, ReadonlySet<string>>>): void {
    for (const section of ['proposals', 'pairs', 'survivors', 'grades'] as const) {
      const entries: Record<string, Verdict<unknown>> = this.#document[section];
      for (const key of Object.keys(entries)) if (!live[section].has(key)) { delete entries[key]; this.#dirty = true; }
    }
  }

  markPass(at: number): void { this.#document.lastPassAt = at; this.#dirty = true; }

  /** One write when something changed; a failed write is logged and the verdicts stay in memory for this process. */
  save(): void {
    if (!this.#dirty || !this.path) return;
    try { writeDocument(this.path, this.#document, { indent: null }); this.#dirty = false; }
    catch (error) { logger.warn('Learning curation verdicts could not be saved', { error: summarizeError(error) }); }
  }
}
