/**
 * skills/service.ts
 *
 * The single canonical skill service. It sits over an injectable `SkillStore`
 * (store.ts) and owns the rules every consumer must share: name validation,
 * create-vs-update semantics, and honest absence. It is deliberately transport-
 * neutral, the daemon CRUD gateway verbs (control-plane/routes/skills.ts) are
 * a thin adapter over this, and a consumer embedding the platform directly can call
 * the same methods without any gateway.
 *
 * Progressive disclosure is preserved end to end: `list` returns index lines
 * (no bodies), `get` returns the one full skill a caller asked for.
 *
 * A skill is addressed by the name `list` shows (case does not matter); with the
 * filesystem store that is the one skill a session loads under that name, and each
 * listed entry carries its `origin` and `path`. Only `create` requires a slug name,
 * because it becomes a file name.
 *
 * Errors are thrown as `SkillServiceError` carrying a stable `code` so an
 * adapter can map them to the right wire status without string-matching.
 */

import {
  isValidSkillName,
  skillContentProblem,
  type Skill,
  type SkillFrontmatterValue,
  type SkillIndexEntry,
} from './model.js';
import { SkillAlreadyExistsError, SkillNotRewritableError, type SkillStore } from './store.js';

/** Stable, adapter-mappable failure codes for skill operations. */
export type SkillErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'ALREADY_EXISTS';

/** A skill-operation failure with a stable code (never a bare prose Error), the state it left, and what to do next. */
export class SkillServiceError extends Error {
  readonly code: SkillErrorCode;
  readonly state: string;
  readonly next: readonly string[];

  constructor(message: string, code: SkillErrorCode, next: readonly string[] = [], state = 'nothing was changed') {
    super(next.length > 0 ? `${message}. ${next[0]}` : message);
    this.name = 'SkillServiceError';
    this.code = code;
    this.state = state;
    this.next = next;
  }
}

/** Fields accepted when creating a new skill. */
export interface CreateSkillInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly metadata?: Readonly<Record<string, SkillFrontmatterValue>> | undefined;
}

/** Fields accepted when updating an existing skill. Every field is optional; absent means unchanged. */
export interface UpdateSkillInput {
  readonly description?: string | undefined;
  readonly body?: string | undefined;
  readonly metadata?: Readonly<Record<string, SkillFrontmatterValue>> | undefined;
}

/** Result of a delete: an honest boolean, never a 200 that pretends a phantom skill was removed. */
export interface DeleteSkillResult {
  readonly name: string;
  readonly deleted: boolean;
  /** The file or skill folder that was removed, when the store keeps skills on disk. */
  readonly path?: string | undefined;
}

const LIST_NEXT = 'Call skills.list for the skills that exist';
const MAX_LOOKUP_NAME_LENGTH = 256;

function requireValidName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new SkillServiceError('skill name is required', 'INVALID_ARGUMENT');
  }
  const trimmed = name.trim();
  if (!isValidSkillName(trimmed)) {
    throw new SkillServiceError(
      `invalid skill name "${trimmed}": must be a slug of letters, digits, "-" or "_" starting with a letter or digit`,
      'INVALID_ARGUMENT',
    );
  }
  return trimmed;
}

/** A name to look a skill up by: any listed name, which may come from a hand-written frontmatter. */
function requireLookupName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new SkillServiceError('skill name is required', 'INVALID_ARGUMENT');
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_LOOKUP_NAME_LENGTH || /[\u0000-\u001f]/.test(trimmed)) {
    throw new SkillServiceError(`invalid skill name "${trimmed.slice(0, 64)}": at most ${MAX_LOOKUP_NAME_LENGTH} characters and no control characters`, 'INVALID_ARGUMENT', [LIST_NEXT]);
  }
  return trimmed;
}

function notFound(name: string): SkillServiceError {
  return new SkillServiceError(`no skill named "${name}"`, 'NOT_FOUND', [LIST_NEXT]);
}

function requireDescription(description: unknown): string {
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new SkillServiceError('skill description is required', 'INVALID_ARGUMENT');
  }
  return description.trim();
}

function requireWritableContent(
  description: string | undefined,
  metadata: Readonly<Record<string, SkillFrontmatterValue>> | undefined,
): void {
  const problem = skillContentProblem(description, metadata);
  if (problem) throw new SkillServiceError(`invalid skill: ${problem}`, 'INVALID_ARGUMENT');
}

export class SkillService {
  private readonly store: SkillStore;
  /** Tail of the in-flight write for each skill name, so read-then-write calls on one name run in order. */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(store: SkillStore) {
    this.store = store;
  }

  private serialized<T>(name: string, run: () => Promise<T>): Promise<T> {
    const key = name.toLowerCase();
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    this.writes.set(key, tail);
    void tail.then(() => { if (this.writes.get(key) === tail) this.writes.delete(key); });
    return next;
  }

  /** List every skill's index line (name + description + metadata), cheap, no bodies. */
  async list(): Promise<SkillIndexEntry[]> {
    return this.store.listIndex();
  }

  /** Read one skill in full, including its Markdown body. Throws NOT_FOUND when absent. */
  async get(name: string): Promise<Skill> {
    const lookupName = requireLookupName(name);
    const skill = await this.store.get(lookupName);
    if (!skill) throw notFound(lookupName);
    return skill;
  }

  /** Create a new skill. Throws ALREADY_EXISTS when the name is taken. */
  async create(input: CreateSkillInput): Promise<Skill> {
    const name = requireValidName(input.name);
    const description = requireDescription(input.description);
    if (typeof input.body !== 'string') {
      throw new SkillServiceError('skill body must be a string', 'INVALID_ARGUMENT');
    }
    requireWritableContent(description, input.metadata);
    return this.serialized(name, async () => {
      try {
        return await this.store.put({
          name,
          description,
          body: input.body,
          metadata: input.metadata ?? {},
        }, { ifAbsent: true });
      } catch (error) {
        if (error instanceof SkillAlreadyExistsError) {
          throw new SkillServiceError(error.message, 'ALREADY_EXISTS', ['Choose another name, or change the existing skill with skills.update']);
        }
        throw error;
      }
    });
  }

  /** Update an existing skill's description, body, and/or metadata. Throws NOT_FOUND when absent. */
  async update(name: string, patch: UpdateSkillInput): Promise<Skill> {
    const lookupName = requireLookupName(name);
    const patchedDescription = patch.description === undefined ? undefined : requireDescription(patch.description);
    if (patch.body !== undefined && typeof patch.body !== 'string') {
      throw new SkillServiceError('skill body must be a string', 'INVALID_ARGUMENT');
    }
    requireWritableContent(patchedDescription, patch.metadata);
    return this.serialized(lookupName, async () => {
      const existing = await this.store.get(lookupName);
      if (!existing) throw notFound(lookupName);
      try {
        return await this.store.put({
          name: existing.name,
          description: patchedDescription ?? existing.description,
          body: patch.body ?? existing.body,
          metadata: patch.metadata ?? existing.metadata,
        });
      } catch (error) {
        if (error instanceof SkillNotRewritableError) {
          throw new SkillServiceError(error.message, 'INVALID_ARGUMENT', [`Change only the body, or edit ${error.path} directly`]);
        }
        throw error;
      }
    });
  }

  /** Delete a skill. Returns { deleted:false } when no skill with that name existed. */
  async delete(name: string): Promise<DeleteSkillResult> {
    const lookupName = requireLookupName(name);
    const removed = await this.serialized(lookupName, () => this.store.delete(lookupName));
    if (!removed) return { name: lookupName, deleted: false };
    return { name: removed.name, deleted: true, ...(removed.path !== undefined ? { path: removed.path } : {}) };
  }
}
