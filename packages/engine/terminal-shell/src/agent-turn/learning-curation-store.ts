import { createHash } from 'node:crypto';
import { readDocument, writeDocument, logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { runStoreFileUpdateSync } from './store-file.js';
import { storeFileChangeStamp } from './store-change-stamp.js';
import type { LearningProposalTarget, LearningScores } from './learning-curator-types.js';

/**
 * What the learning curation pass already settled, so the curator's overview,
 * candidate lookups and promotions read stored verdicts instead of asking a
 * model again. Every verdict carries the content hash of what it was read
 * from; a verdict whose hash no longer matches the record is simply not used,
 * and the next pass reads that record again. The document is held in memory
 * by its owner (one per store path per process), read again when another
 * process changed the file, and saved under the store lock with this
 * process's changes merged over the file's.
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
  /**
   * Candidates promoted to a record this process's libraries may not show (a
   * memory created on an adopted daemon), by promotion reference; the value is
   * the made record's id. Kept while the candidate's source record exists.
   */
  promotions: Record<string, Verdict<string>>;
}

type Section = 'proposals' | 'pairs' | 'survivors' | 'grades' | 'promotions';
const SECTIONS = ['proposals', 'pairs', 'survivors', 'grades', 'promotions'] as const satisfies readonly Section[];

function emptyDocument(): LearningCurationDocument {
  return { version: 1, lastPassAt: null, proposals: {}, pairs: {}, survivors: {}, grades: {}, promotions: {} };
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
  return { version: 1, lastPassAt, proposals: section('proposals'), pairs: section('pairs'), survivors: section('survivors'), grades: section('grades'),
    promotions: section('promotions') };
}

type PendingSection = Map<string, Verdict<unknown> | null>;

function readStoredDocument(path: string): LearningCurationDocument | null {
  return readDocument(path, {
    label: 'agent/learning-curation', validate,
    recovery: 'The learning curator starts with no stored verdicts; the next memory action:"curate" pass reads the records again.',
  });
}

export class LearningCurationStore {
  #document: LearningCurationDocument;
  /** The file stamp the held document was read at or last written as. */
  #stamp: string;
  /** What this process changed since its last save (null: removed), laid over a fresher file on reload and save. */
  #pending: Record<Section, PendingSection> = { proposals: new Map(), pairs: new Map(), survivors: new Map(), grades: new Map(), promotions: new Map() };
  #pendingPassAt: number | undefined;

  private constructor(private readonly path: string | undefined, document: LearningCurationDocument, stamp: string) {
    this.#document = document;
    this.#stamp = stamp;
  }

  static #owners = new Map<string, LearningCurationStore>();

  /**
   * The one owner of the curation document under these paths; an in-memory
   * store when there is no workspace. Another process (the daemon's hosted
   * Agent turn, a second terminal) may have run a pass since this one read the
   * file, so one stat per acquire decides whether the held copy is still the
   * file's; a changed file is read again with this process's unsaved verdicts
   * laid over it.
   */
  static forPaths(paths: Pick<ShellPathService, 'resolveUserPath'> | undefined): LearningCurationStore {
    if (!paths) return new LearningCurationStore(undefined, emptyDocument(), 'absent');
    const path = paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'learning-curation.json');
    const owned = LearningCurationStore.#owners.get(path);
    if (owned) { owned.#refresh(); return owned; }
    let document = emptyDocument();
    let stamp = 'absent';
    try {
      stamp = storeFileChangeStamp(path);
      document = readStoredDocument(path) ?? emptyDocument();
    } catch (error) {
      logger.warn('Learning curation verdicts could not be read; starting without them', { error: summarizeError(error) });
    }
    const store = new LearningCurationStore(path, document, stamp);
    LearningCurationStore.#owners.set(path, store);
    return store;
  }

  #refresh(): void {
    if (!this.path) return;
    try {
      const stamp = storeFileChangeStamp(this.path);
      if (stamp === this.#stamp) return;
      this.#document = this.#overlay(readStoredDocument(this.path) ?? emptyDocument());
      this.#stamp = stamp;
    } catch (error) {
      logger.warn('Learning curation verdicts could not be read again; keeping the ones held', { error: summarizeError(error) });
    }
  }

  #overlay(document: LearningCurationDocument): LearningCurationDocument {
    for (const section of SECTIONS) {
      const entries: Record<string, Verdict<unknown>> = document[section];
      for (const [key, verdict] of this.#pending[section]) {
        if (verdict === null) delete entries[key];
        else entries[key] = verdict;
      }
    }
    if (this.#pendingPassAt !== undefined) document.lastPassAt = this.#pendingPassAt;
    return document;
  }

  #hasPending(): boolean {
    return this.#pendingPassAt !== undefined || Object.values(this.#pending).some(section => section.size > 0);
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
    const verdict = { hash, value };
    entries[key] = verdict;
    this.#pending[section].set(key, verdict);
  }

  proposal(key: string, hash: string): StoredLearningProposal | undefined { return this.#get('proposals', key, hash) as StoredLearningProposal | undefined; }
  setProposal(key: string, hash: string, value: StoredLearningProposal): void { this.#set('proposals', key, hash, value); }
  pair(key: string, hash: string): boolean | undefined { return this.#get('pairs', key, hash) as boolean | undefined; }
  setPair(key: string, hash: string, same: boolean): void { this.#set('pairs', key, hash, same); }
  survivor(key: string, hash: string): string | undefined { return this.#get('survivors', key, hash) as string | undefined; }
  setSurvivor(key: string, hash: string, id: string): void { this.#set('survivors', key, hash, id); }
  grade(key: string, hash: string): StoredLearningGrade | undefined { return this.#get('grades', key, hash) as StoredLearningGrade | undefined; }
  setGrade(key: string, hash: string, value: StoredLearningGrade): void { this.#set('grades', key, hash, value); }
  /** Whether the candidate behind this promotion reference was promoted (see `promotions`). */
  promoted(reference: string): boolean { return this.#get('promotions', reference, '') !== undefined; }
  setPromotion(reference: string, recordId: string): void { this.#set('promotions', reference, '', recordId); }

  /** Drops verdicts for keys the pass no longer saw, so the document stays the size of what exists. */
  retainOnly(live: Readonly<Record<Section, ReadonlySet<string>>>): void {
    for (const section of SECTIONS) {
      const entries: Record<string, Verdict<unknown>> = this.#document[section];
      for (const key of Object.keys(entries)) if (!live[section].has(key)) { delete entries[key]; this.#pending[section].set(key, null); }
    }
  }

  markPass(at: number): void { this.#document.lastPassAt = at; this.#pendingPassAt = at; }

  /**
   * One locked write when something changed. Under the store lock the file is
   * read again only when its stamp moved since this process read or wrote it,
   * and this pass's changed keys are laid over what another process stored, so
   * neither process's paid verdicts are lost. A failed write is logged and the
   * changes stay pending in memory for the next save.
   */
  save(): void {
    const path = this.path;
    if (!path || !this.#hasPending()) return;
    try {
      runStoreFileUpdateSync(path, () => {
        const stamp = storeFileChangeStamp(path);
        const document = stamp === this.#stamp ? this.#document : this.#overlay(readStoredDocument(path) ?? emptyDocument());
        writeDocument(path, document, { indent: null });
        this.#document = document;
        this.#stamp = storeFileChangeStamp(path);
        for (const section of Object.values(this.#pending)) section.clear();
        this.#pendingPassAt = undefined;
      });
    } catch (error) { logger.warn('Learning curation verdicts could not be saved', { error: summarizeError(error) }); }
  }
}
