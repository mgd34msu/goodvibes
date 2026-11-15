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
import { SkillAlreadyExistsError, type SkillStore } from './store.js';

/** Stable, adapter-mappable failure codes for skill operations. */
export type SkillErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'ALREADY_EXISTS';

/** A skill-operation failure with a stable code (never a bare prose Error). */
export class SkillServiceError extends Error {
  readonly code: SkillErrorCode;

  constructor(message: string, code: SkillErrorCode) {
    super(message);
    this.name = 'SkillServiceError';
    this.code = code;
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
}

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
    const previous = this.writes.get(name) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    this.writes.set(name, tail);
    void tail.then(() => { if (this.writes.get(name) === tail) this.writes.delete(name); });
    return next;
  }

  /** List every skill's index line (name + description + metadata), cheap, no bodies. */
  async list(): Promise<SkillIndexEntry[]> {
    return this.store.listIndex();
  }

  /** Read one skill in full, including its Markdown body. Throws NOT_FOUND when absent. */
  async get(name: string): Promise<Skill> {
    const validName = requireValidName(name);
    const skill = await this.store.get(validName);
    if (!skill) {
      throw new SkillServiceError(`no skill named "${validName}"`, 'NOT_FOUND');
    }
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
          throw new SkillServiceError(`a skill named "${name}" already exists`, 'ALREADY_EXISTS');
        }
        throw error;
      }
    });
  }

  /** Update an existing skill's description, body, and/or metadata. Throws NOT_FOUND when absent. */
  async update(name: string, patch: UpdateSkillInput): Promise<Skill> {
    const validName = requireValidName(name);
    const patchedDescription = patch.description === undefined ? undefined : requireDescription(patch.description);
    if (patch.body !== undefined && typeof patch.body !== 'string') {
      throw new SkillServiceError('skill body must be a string', 'INVALID_ARGUMENT');
    }
    requireWritableContent(patchedDescription, patch.metadata);
    return this.serialized(validName, async () => {
      const existing = await this.store.get(validName);
      if (!existing) {
        throw new SkillServiceError(`no skill named "${validName}"`, 'NOT_FOUND');
      }
      return this.store.put({
        name: validName,
        description: patchedDescription ?? existing.description,
        body: patch.body ?? existing.body,
        metadata: patch.metadata ?? existing.metadata,
      });
    });
  }

  /** Delete a skill. Returns { deleted:false } when no skill with that name existed. */
  async delete(name: string): Promise<DeleteSkillResult> {
    const validName = requireValidName(name);
    const deleted = await this.serialized(validName, () => this.store.delete(validName));
    return { name: validName, deleted };
  }
}
