/**
 * skills/store.ts
 *
 * Storage seam for the skill model. The store is an injectable interface so the
 * `SkillService` (service.ts) has no direct filesystem or transport dependency:
 * a consumer can back it with skill directories (the bundled `FileSystemSkillStore`
 * below), an in-memory map for tests, or a remote store, without the service or the
 * gateway verbs changing.
 *
 * The filesystem store reads the same skill roots, in the same order and both formats,
 * that the terminal apps load skills from (roots.ts, discovery.ts), so a skill listed
 * here is the skill a session uses. New skills are written as `<name>.md` in one
 * directory; an update rewrites the document where it was found; `delete` means delete.
 */

import { link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  findSkill,
  readLocatedSkill,
  readSkillDocumentText,
  listSkillIndex,
  type LocatedSkillIndex,
} from './discovery.js';
import {
  frontmatterRewriteProblem,
  isValidSkillName,
  replaceSkillBody,
  serializeSkill,
  type Skill,
  type SkillFrontmatterValue,
  type SkillIndexEntry,
} from './model.js';
import type { SkillOrigin, SkillRoot } from './roots.js';

/** The storage operations the `SkillService` needs. All async, all honest about absence. */
export interface SkillStore {
  /** Cheap index-line read for every skill, never materializes bodies. */
  listIndex(): Promise<SkillIndexEntry[]>;
  /** Full read of one skill (body included), or null when it does not exist. */
  get(name: string): Promise<Skill | null>;
  /** Whether a skill with this name currently exists. */
  has(name: string): Promise<boolean>;
  /**
   * Write a skill (create or overwrite), returning the stored form. With `ifAbsent`, a skill
   * that already exists is left untouched and `SkillAlreadyExistsError` is thrown.
   */
  put(skill: Skill, options?: { readonly ifAbsent?: boolean }): Promise<Skill>;
  /** Remove a skill, returning the index line of what was removed, or null when no skill had that name. */
  delete(name: string): Promise<SkillIndexEntry | null>;
}

/** Thrown by `put(..., { ifAbsent: true })` when the skill already exists. */
export class SkillAlreadyExistsError extends Error {
  readonly path: string | undefined;

  constructor(name: string, path?: string, message?: string) {
    super(message ?? `a skill named "${name}" already exists${path ? ` at ${path}` : ''}`);
    this.name = 'SkillAlreadyExistsError';
    this.path = path;
  }
}

/** Thrown by `put` when a skill's frontmatter would lose something its author wrote if rewritten. */
export class SkillNotRewritableError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`the frontmatter of ${path} cannot be rewritten without loss: ${problem}`);
    this.name = 'SkillNotRewritableError';
    this.path = path;
  }
}

/** Where a filesystem store looks for skills and where it creates new ones. */
export interface FileSystemSkillStoreOptions {
  /** Skill roots in search order, normally from `resolveSkillRoots`. */
  readonly roots: readonly SkillRoot[];
  /** Directory new skills are written to as `<name>.md`. */
  readonly createIn: string;
}

const SKILL_FILE_SUFFIX = '.md';
let tempCounter = 0;

function sameValue(left: SkillFrontmatterValue | undefined, right: SkillFrontmatterValue | undefined): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameFrontmatter(left: SkillIndexEntry, right: SkillIndexEntry): boolean {
  const leftKeys = Object.keys(left.metadata);
  const rightKeys = Object.keys(right.metadata);
  return left.name === right.name
    && left.description === right.description
    && leftKeys.length === rightKeys.length
    && leftKeys.every((key) => sameValue(left.metadata[key], right.metadata[key]));
}

/** Write `text` to `path` through a staged file, so a crash never leaves a torn skill document. */
async function publish(path: string, text: string, ifAbsent: boolean, name: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staged = `${path}.${process.pid}.${tempCounter++}.tmp`;
  await writeFile(staged, text, 'utf8');
  try {
    if (ifAbsent) {
      // A hard link fails when the target exists, which makes the create atomic across processes.
      try { await link(staged, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new SkillAlreadyExistsError(name, path, `${path} already exists, so a skill named "${name}" cannot be written there`);
        }
        throw error;
      }
    } else {
      await rename(staged, path);
    }
  } finally {
    await rm(staged, { force: true });
  }
}

/** A store over skill directories: the roots the terminal apps read, plus one directory new skills go to. */
export class FileSystemSkillStore implements SkillStore {
  private readonly roots: readonly SkillRoot[];
  private readonly createIn: string;
  private readonly createOrigin: SkillOrigin;

  /** `directory` alone is one global root that new skills are also written to. */
  constructor(source: string | FileSystemSkillStoreOptions) {
    const options: FileSystemSkillStoreOptions = typeof source === 'string'
      ? { roots: [{ directory: resolve(source), origin: 'global' }], createIn: source }
      : source;
    this.roots = options.roots.map((root) => ({ directory: resolve(root.directory), origin: root.origin }));
    this.createIn = resolve(options.createIn);
    this.createOrigin = this.roots.find((root) => root.directory === this.createIn)?.origin ?? 'custom';
  }

  async listIndex(): Promise<SkillIndexEntry[]> {
    return (await listSkillIndex(this.roots)).map(toEntry);
  }

  async get(name: string): Promise<Skill | null> {
    const found = await findSkill(this.roots, name);
    if (!found) return null;
    const skill = await readLocatedSkill(found);
    if (!skill) return null;
    const { format: _format, ...rest } = skill;
    return rest;
  }

  async has(name: string): Promise<boolean> {
    return (await findSkill(this.roots, name)) !== undefined;
  }

  async put(skill: Skill, options?: { readonly ifAbsent?: boolean }): Promise<Skill> {
    const found = await findSkill(this.roots, skill.name);
    if (found && options?.ifAbsent) throw new SkillAlreadyExistsError(found.name, found.path);
    if (!found) {
      if (!isValidSkillName(skill.name)) throw new Error(`invalid skill name "${skill.name}" for a new skill file`);
      const path = join(this.createIn, `${skill.name}${SKILL_FILE_SUFFIX}`);
      // Never replace a file the name did not resolve to (it may hold a skill under another name).
      await publish(path, serializeSkill(skill), true, skill.name);
      return this.stored(skill, path, this.createOrigin);
    }
    await publish(found.path, await this.rewrite(found, skill), false, skill.name);
    return this.stored({ ...skill, name: found.name }, found.path, found.origin);
  }

  async delete(name: string): Promise<SkillIndexEntry | null> {
    const found = await findSkill(this.roots, name);
    if (!found) return null;
    // A folder skill is the folder: its SKILL.md and the files it ships with.
    await rm(found.format === 'folder' ? dirname(found.path) : found.path, { recursive: true, force: true });
    return toEntry(found);
  }

  /**
   * The new text for a skill found on disk. A change to the body alone keeps the author's
   * frontmatter byte for byte; a change to the description or metadata rewrites it, which
   * is refused when that would drop YAML the line format cannot hold.
   */
  private async rewrite(found: LocatedSkillIndex, skill: Skill): Promise<string> {
    const current = await readSkillDocumentText(found.path);
    if (current !== null && sameFrontmatter(found, { ...skill, name: found.name })) {
      const kept = replaceSkillBody(current, skill.body);
      if (kept !== undefined) return kept;
    }
    if (current !== null) {
      const problem = frontmatterRewriteProblem(current);
      if (problem) throw new SkillNotRewritableError(found.path, problem);
    }
    return serializeSkill({ ...skill, name: found.name });
  }

  private async stored(skill: Skill, path: string, origin: SkillOrigin): Promise<Skill> {
    const info = await stat(path);
    return { ...skill, updatedAt: info.mtimeMs, origin, path };
  }
}

function toEntry(entry: LocatedSkillIndex): SkillIndexEntry {
  const { format: _format, ...rest } = entry;
  return rest;
}

/** An in-memory skill store, the reference implementation for tests. */
export class InMemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, Skill>();

  async listIndex(): Promise<SkillIndexEntry[]> {
    return [...this.skills.values()]
      .map(({ body: _body, ...index }) => index)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Skill | null> {
    return this.skills.get(name) ?? null;
  }

  async has(name: string): Promise<boolean> {
    return this.skills.has(name);
  }

  async put(skill: Skill, options?: { readonly ifAbsent?: boolean }): Promise<Skill> {
    if (options?.ifAbsent && this.skills.has(skill.name)) throw new SkillAlreadyExistsError(skill.name);
    const stored: Skill = { ...skill, updatedAt: Date.now() };
    this.skills.set(skill.name, stored);
    return stored;
  }

  async delete(name: string): Promise<SkillIndexEntry | null> {
    const existing = this.skills.get(name);
    if (!existing) return null;
    this.skills.delete(name);
    const { body: _body, ...index } = existing;
    return index;
  }
}
