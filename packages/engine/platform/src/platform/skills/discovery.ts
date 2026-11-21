/**
 * skills/discovery.ts
 *
 * Reads the skills in a list of skill roots (roots.ts). This is the one reader of skill
 * directories: the filesystem store behind the skills.* verbs, the terminal apps'
 * discovery and the model's registry tool all call it. A caller that reads through its
 * own view of the files (a contract run's captured inputs) passes a `SkillDocumentSource`;
 * the names, case rules and descriptions are the same either way.
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
import { StringDecoder } from 'node:string_decoder';
import {
  followFrontmatter,
  isValidSkillName,
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

/**
 * Where skill documents are read from when not straight from the filesystem: a listing
 * of a directory, whether a path exists, and a whole document's text. Any of them may
 * throw; a root or document that cannot be read holds no skill.
 */
export interface SkillDocumentSource {
  list(directory: string): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

interface ReadDocument { readonly text: string; readonly updatedAt?: number | undefined }

/** How one scan lists roots and reads documents. */
interface DocumentReader {
  list(directory: string): Promise<readonly string[]>;
  /** A document whole, or at least through its closing frontmatter fence; null when it is not a readable file. */
  read(path: string, whole: boolean): Promise<ReadDocument | null>;
}

const filesystemReader: DocumentReader = {
  list: (directory) => readdir(directory),
  read: (path, whole) => readDocument(path, whole),
};

function readerFor(source: SkillDocumentSource | undefined): DocumentReader {
  if (source === undefined) return filesystemReader;
  return {
    list: (directory) => source.list(directory),
    read: async (path) => {
      try {
        if (!await source.exists(path)) return null;
        return { text: await source.read(path) };
      } catch {
        return null;
      }
    },
  };
}

interface Candidate {
  readonly path: string;
  readonly origin: SkillOrigin;
  readonly format: SkillFormat;
  readonly fallbackName: string;
}

async function rootCandidates(root: SkillRoot, reader: DocumentReader): Promise<Candidate[]> {
  let entries: string[];
  try {
    entries = [...await reader.list(root.directory)];
  } catch {
    // A root that does not exist holds no skills; that is not an error.
    return [];
  }
  return entries.sort((a, b) => a.localeCompare(b)).map((entry): Candidate => entry.endsWith(SKILL_FILE_SUFFIX)
    ? { path: join(root.directory, entry), origin: root.origin, format: 'file', fallbackName: entry.slice(0, -SKILL_FILE_SUFFIX.length) }
    : { path: join(root.directory, entry, SKILL_FOLDER_DOCUMENT), origin: root.origin, format: 'folder', fallbackName: entry });
}

/** Read a skill document whole, or only up to its closing frontmatter fence. Null when it is not a readable file. */
async function readDocument(path: string, whole: boolean): Promise<ReadDocument | null> {
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
    // Each chunk is decoded once and each line tested once, so the read stays linear in
    // the length of a frontmatter that never closes.
    const decoder = new StringDecoder('utf8');
    const frontmatter = followFrontmatter();
    const chunk = Buffer.allocUnsafe(HEAD_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, HEAD_CHUNK_BYTES, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (frontmatter.add(decoder.write(chunk.subarray(0, bytesRead)))) break;
    }
    return { text: frontmatter.text() + decoder.end(), updatedAt: info.mtimeMs };
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
  reader: DocumentReader,
  read: (candidate: Candidate) => Promise<T | null>,
): Promise<T[]> {
  const perRoot = await Promise.all(roots.map(async (root) => mapInBatches(await rootCandidates(root, reader), read)));
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
export function listSkillIndex(roots: readonly SkillRoot[], source?: SkillDocumentSource): Promise<LocatedSkillIndex[]> {
  const reader = readerFor(source);
  return scan(roots, reader, async (candidate) => {
    const read = await reader.read(candidate.path, false);
    return read ? locate(parseSkillIndex(read.text, read.updatedAt), candidate) : null;
  });
}

/** Every skill in `roots` with its body, project skills first. */
export function listSkills(roots: readonly SkillRoot[], source?: SkillDocumentSource): Promise<LocatedSkill[]> {
  const reader = readerFor(source);
  return scan(roots, reader, async (candidate) => {
    const read = await reader.read(candidate.path, true);
    return read ? locate(parseSkill(read.text, read.updatedAt), candidate) : null;
  });
}

/**
 * The skill `name` resolves to (case does not matter), the same one `listSkillIndex` lists.
 * The document named after it is opened first (`<root>/<name>/SKILL.md`, then
 * `<root>/<name>.md`, in root order, as the listing orders them), so loading one skill
 * reads one document rather than every skill's frontmatter. Only the roots before the
 * one it was found in are listed, since an earlier root wins a name. A name with no
 * such document, or a document that names another skill, falls back to the listing.
 */
export async function findSkill(roots: readonly SkillRoot[], name: string, source?: SkillDocumentSource): Promise<LocatedSkillIndex | undefined> {
  const key = name.toLowerCase();
  const direct = isValidSkillName(name) ? await findSkillByPath(roots, name, key, source) : null;
  if (direct !== null) return direct;
  return (await listSkillIndex(roots, source)).find((entry) => entry.name.toLowerCase() === key);
}

/** The skill at `name`'s own path, or null when the listing must decide. */
async function findSkillByPath(roots: readonly SkillRoot[], name: string, key: string, source: SkillDocumentSource | undefined): Promise<LocatedSkillIndex | null> {
  const reader = readerFor(source);
  for (const [index, root] of roots.entries()) {
    const candidates: Candidate[] = [
      { path: join(root.directory, name, SKILL_FOLDER_DOCUMENT), origin: root.origin, format: 'folder', fallbackName: name },
      { path: join(root.directory, `${name}${SKILL_FILE_SUFFIX}`), origin: root.origin, format: 'file', fallbackName: name },
    ];
    for (const candidate of candidates) {
      const read = await reader.read(candidate.path, false);
      if (!read) continue;
      const located = locate(parseSkillIndex(read.text, read.updatedAt), candidate);
      if (located.name.toLowerCase() !== key) return null;
      if (index > 0 && (await listSkillIndex(roots.slice(0, index), source)).some((entry) => entry.name.toLowerCase() === key)) return null;
      return located;
    }
  }
  return null;
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
