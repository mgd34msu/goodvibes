/**
 * skills/discovery.ts
 *
 * Reads the skills in a list of skill roots (roots.ts). This is the one reader of skill
 * directories: the filesystem store behind the skills.* verbs and the terminal apps'
 * discovery both call it.
 *
 * - Both on-disk formats: `<root>/<name>.md` and `<root>/<folder>/SKILL.md`.
 * - A skill's name is its frontmatter `name`, or the file stem / folder name when the
 *   frontmatter has none. Names are unique without regard to case; the first root that
 *   holds a name wins, which is how a project skill overrides a global one.
 * - A skill's description is its frontmatter `description`, or `summary` when absent.
 * - `listSkillIndex` reads each document only up to the closing frontmatter fence;
 *   `listSkills` reads whole documents for callers that need the body.
 */

import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  frontmatterIsComplete,
  parseSkill,
  parseSkillIndex,
  type Skill,
  type SkillFrontmatterValue,
  type SkillIndexEntry,
} from './model.js';
import { compareSkillsByOrigin, type SkillOrigin, type SkillRoot } from './roots.js';

/** `file` is a flat `<name>.md`; `folder` is `<folder>/SKILL.md` with the folder as the skill. */
export type SkillFormat = 'file' | 'folder';

/** A skill's index line together with where it was found. */
export interface LocatedSkillIndex extends SkillIndexEntry {
  readonly origin: SkillOrigin;
  readonly path: string;
  readonly format: SkillFormat;
}

/** A whole skill together with where it was found. */
export interface LocatedSkill extends Skill {
  readonly origin: SkillOrigin;
  readonly path: string;
  readonly format: SkillFormat;
}

/** The document a skill folder holds. */
export const SKILL_FOLDER_DOCUMENT = 'SKILL.md';
const SKILL_FILE_SUFFIX = '.md';
const HEAD_CHUNK_BYTES = 4096;
/** Files read at once per root, so a large skill directory does not open every file together. */
const READS_IN_FLIGHT = 32;

interface Candidate {
  readonly path: string;
  readonly origin: SkillOrigin;
  readonly format: SkillFormat;
  readonly fallbackName: string;
}

async function rootCandidates(root: SkillRoot): Promise<Candidate[]> {
  let entries: string[];
  try {
    entries = await readdir(root.directory);
  } catch {
    // A root that does not exist holds no skills; that is not an error.
    return [];
  }
  return entries.sort((a, b) => a.localeCompare(b)).map((entry): Candidate => entry.endsWith(SKILL_FILE_SUFFIX)
    ? { path: join(root.directory, entry), origin: root.origin, format: 'file', fallbackName: entry.slice(0, -SKILL_FILE_SUFFIX.length) }
    : { path: join(root.directory, entry, SKILL_FOLDER_DOCUMENT), origin: root.origin, format: 'folder', fallbackName: entry });
}

/** Read a skill document whole, or only up to its closing frontmatter fence. Null when it is not a readable file. */
async function readDocument(path: string, whole: boolean): Promise<{ text: string; updatedAt: number } | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (whole) return { text: await handle.readFile('utf8'), updatedAt: info.mtimeMs };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(HEAD_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, HEAD_CHUNK_BYTES, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (frontmatterIsComplete(Buffer.concat(chunks, total).toString('utf8'))) break;
    }
    return { text: Buffer.concat(chunks, total).toString('utf8'), updatedAt: info.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function scalar(value: SkillFrontmatterValue | undefined): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.join(', ') : '';
}

function locate<T extends SkillIndexEntry>(parsed: T, candidate: Candidate): T & { origin: SkillOrigin; path: string; format: SkillFormat } {
  return {
    ...parsed,
    name: parsed.name.trim() || candidate.fallbackName,
    description: parsed.description || scalar(parsed.metadata.summary),
    origin: candidate.origin,
    path: candidate.path,
    format: candidate.format,
  };
}

async function mapInBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += READS_IN_FLIGHT) {
    out.push(...await Promise.all(items.slice(start, start + READS_IN_FLIGHT).map(run)));
  }
  return out;
}

async function scan<T extends { readonly name: string; readonly origin: SkillOrigin }>(
  roots: readonly SkillRoot[],
  read: (candidate: Candidate) => Promise<T | null>,
): Promise<T[]> {
  const perRoot = await Promise.all(roots.map(async (root) => mapInBatches(await rootCandidates(root), read)));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const records of perRoot) {
    for (const record of records) {
      if (!record) continue;
      const key = record.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(record);
    }
  }
  return out.sort(compareSkillsByOrigin);
}

/** The index line of every skill in `roots`, project skills first. Reads frontmatter only. */
export function listSkillIndex(roots: readonly SkillRoot[]): Promise<LocatedSkillIndex[]> {
  return scan(roots, async (candidate) => {
    const read = await readDocument(candidate.path, false);
    return read ? locate(parseSkillIndex(read.text, read.updatedAt), candidate) : null;
  });
}

/** Every skill in `roots` with its body, project skills first. */
export function listSkills(roots: readonly SkillRoot[]): Promise<LocatedSkill[]> {
  return scan(roots, async (candidate) => {
    const read = await readDocument(candidate.path, true);
    return read ? locate(parseSkill(read.text, read.updatedAt), candidate) : null;
  });
}

/** The skill `name` resolves to (case does not matter), the same one `listSkillIndex` lists. */
export async function findSkill(roots: readonly SkillRoot[], name: string): Promise<LocatedSkillIndex | undefined> {
  const key = name.toLowerCase();
  return (await listSkillIndex(roots)).find((entry) => entry.name.toLowerCase() === key);
}

/** Read a found skill whole. Null when its document disappeared since it was found. */
export async function readLocatedSkill(entry: LocatedSkillIndex): Promise<LocatedSkill | null> {
  const read = await readDocument(entry.path, true);
  if (!read) return null;
  const candidate: Candidate = { path: entry.path, origin: entry.origin, format: entry.format, fallbackName: entry.name };
  return { ...locate(parseSkill(read.text, read.updatedAt), candidate), name: entry.name };
}

/** Read the raw text of a skill document, or null when it cannot be read. */
export async function readSkillDocumentText(path: string): Promise<string | null> {
  return (await readDocument(path, true))?.text ?? null;
}
