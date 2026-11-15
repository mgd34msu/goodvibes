/**
 * skills/store.ts
 *
 * Storage seam for the skill model. The store is an injectable interface so the
 * `SkillService` (service.ts) has no direct filesystem or transport dependency
 *, a consumer can back it with a directory of Markdown files (the bundled
 * `FileSystemSkillStore` below), an in-memory map for tests, or a remote store,
 * without the service or the gateway verbs changing. This is the same
 * injectable-I/O shape the push and subscription stores follow.
 *
 * The filesystem store is the canonical on-disk form: one `<name>.md` document
 * per skill in a single directory, which is exactly the Markdown-plus-
 * frontmatter shape `model.ts` reads and writes. `delete` means delete, the
 * file is removed, not tombstoned.
 */

import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parseSkill,
  parseSkillIndex,
  serializeSkill,
  type Skill,
  type SkillIndexEntry,
} from './model.js';

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
  /** Remove a skill. Returns false when no skill with that name existed. */
  delete(name: string): Promise<boolean>;
}

/** Thrown by `put(..., { ifAbsent: true })` when the skill already exists. */
export class SkillAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`a skill named "${name}" already exists`);
    this.name = 'SkillAlreadyExistsError';
  }
}

const SKILL_FILE_SUFFIX = '.md';
let tempCounter = 0;

/** A directory-of-Markdown-files skill store. */
export class FileSystemSkillStore implements SkillStore {
  private readonly dir: string;

  constructor(directory: string) {
    this.dir = resolve(directory);
  }

  private filePath(name: string): string {
    return join(this.dir, `${name}${SKILL_FILE_SUFFIX}`);
  }

  private async readEntry(fileName: string): Promise<{ text: string; updatedAt: number } | null> {
    try {
      const path = join(this.dir, fileName);
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return { text, updatedAt: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async listIndex(): Promise<SkillIndexEntry[]> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.dir);
    } catch {
      // A store whose directory does not exist yet is an empty store, not an error.
      return [];
    }
    const skillFiles = fileNames.filter((name) => name.endsWith(SKILL_FILE_SUFFIX));
    const entries: SkillIndexEntry[] = [];
    for (const fileName of skillFiles) {
      const read = await this.readEntry(fileName);
      if (!read) continue;
      // Index read: parseSkillIndex discards the body, so nothing but the
      // frontmatter line ever crosses back to the caller.
      // The file name is the address (get/update/delete use it), so it is the name; a
      // different `name:` inside the file would list a skill that cannot be opened.
      entries.push({ ...parseSkillIndex(read.text, read.updatedAt), name: fileName.slice(0, -SKILL_FILE_SUFFIX.length) });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Skill | null> {
    try {
      const path = this.filePath(name);
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return { ...parseSkill(text, info.mtimeMs), name };
    } catch {
      return null;
    }
  }

  async has(name: string): Promise<boolean> {
    try {
      await stat(this.filePath(name));
      return true;
    } catch {
      return false;
    }
  }

  async put(skill: Skill, options?: { readonly ifAbsent?: boolean }): Promise<Skill> {
    await mkdir(this.dir, { recursive: true });
    const path = this.filePath(skill.name);
    // Stage then publish, so a crash never leaves a torn skill file.
    const staged = `${path}.${process.pid}.${tempCounter++}.tmp`;
    await writeFile(staged, serializeSkill(skill), 'utf8');
    try {
      if (options?.ifAbsent) {
        // A hard link fails when the target exists, which makes the create atomic across processes.
        try { await link(staged, path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SkillAlreadyExistsError(skill.name);
          throw error;
        }
      } else {
        await rename(staged, path);
      }
    } finally {
      await rm(staged, { force: true });
    }
    const info = await stat(path);
    return { ...skill, updatedAt: info.mtimeMs };
  }

  async delete(name: string): Promise<boolean> {
    const path = this.filePath(name);
    try {
      await stat(path);
    } catch {
      return false;
    }
    await rm(path, { force: true });
    return true;
  }
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

  async delete(name: string): Promise<boolean> {
    return this.skills.delete(name);
  }
}
