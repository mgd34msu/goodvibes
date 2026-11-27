/**
 * skills/library.ts, the one skill store with GoodVibes' facts about each
 * skill: the daemon's skill files (roots.ts: `<project>/.goodvibes/skills`,
 * `<project>/.goodvibes/<program>/skills`, `~/.goodvibes/skills`,
 * `~/.goodvibes/<program>/skills`, as `<name>.md` or `<folder>/SKILL.md`), the
 * same files the daemon's skills.* methods and every turn's skill reader use.
 *
 * What GoodVibes keeps beside a skill's text is written into its frontmatter:
 * `title` (the name a person gave it), `enabled`, `review`, `triggers`, `tags`,
 * `requires-env`, `requires-commands`, `source`, `provenance`, `stale-reason`,
 * `reviewed-at`, `created-at`, `updated-at`. A file without them (one dropped
 * in by hand or written through skills.create) reads as a skill nobody has
 * reviewed yet, switched off. Skill bundles, and the store's revision that
 * every change advances, are kept in `~/.goodvibes/skills/skill-library.json`.
 *
 * The Agent kept its skills in a file of its own until 3.5.0
 * (`~/.goodvibes/agent/skills/skills.json`). The first read of this store in a
 * home carries every skill and bundle in it here, once, nothing dropped; the
 * old file is left as it was, so a 3.5.0 Agent started again reads it as before.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync, type AtomicWriteOptions } from '../config/atomic-write.js';
import { writeHeldFile } from '../capabilities/held-paths.js';
import { withProcessLockSync } from '../utils/process-lock.js';
import { containsIssuerCredential } from '../utils/redaction.js';
import { projectFilesHeld } from '../utils/prompt-loader.js';
import { acceptedAuthor, authorAfterChange, memoryAwaitsOwner, newRecordAuthor, readRecordAuthor, type MemoryAuthor } from '../state/memory-author.js';
import { frontmatterRewriteProblem, parseSkill, serializeSkill, skillContentProblem, type SkillFrontmatterValue } from './model.js';
import { compareSkillsByOrigin, resolveSkillRoots, type SkillOrigin, type SkillRoot } from './roots.js';
import type {
  AgentSkillBundleCreateInput, AgentSkillBundleReadiness, AgentSkillBundleRecord, AgentSkillBundleUpdateInput,
  AgentSkillCreateInput, AgentSkillDeleteResult, AgentSkillReadiness, AgentSkillRecord, AgentSkillRequirement,
  AgentSkillRequirementKind, AgentSkillReviewState, AgentSkillSnapshot, AgentSkillSource, AgentSkillUpdateInput,
} from './library-types.js';

export type * from './library-types.js';

/** The library file's name, in the shared skill folder. */
export const SKILL_LIBRARY_FILE = 'skill-library.json';
const LIBRARY_VERSION = 1;
const SKILL_FILE_SUFFIX = '.md';
const FOLDER_DOCUMENT = 'SKILL.md';

/** The frontmatter keys GoodVibes writes; every other key in a file is the author's and is kept as written. */
const MARK_KEYS = ['title', 'enabled', 'review', 'triggers', 'tags', 'requires-env', 'requires-commands', 'source', 'provenance', 'stale-reason', 'reviewed-at', 'created-at', 'updated-at', 'author', 'author-who', 'author-accepted-at'] as const;
const MARK_KEY_SET = new Set<string>(MARK_KEYS);

/** Writes made on behalf of a tool call carry its checks (the projection is current; this effect is its own). */
export type SkillLibraryWriteEffects = Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'>;

// ---------------------------------------------------------------------------
// Small rules shared with every program
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*\S{6,}/i,
];

function assertNoSecretLikeText(fields: readonly string[], ownerLabel: string): void {
  if (fields.some((field) => containsIssuerCredential(field) || SECRET_PATTERNS.some((pattern) => pattern.test(field)))) {
    throw new Error(`${ownerLabel} cannot store secret-looking values. Store a secret reference or remove the sensitive text.`);
  }
}

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
function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}
/** Collapse embedded newlines and whitespace runs so a description is always a single line. */
function normalizeDescription(description: string): string {
  return description.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  return slug || 'skill';
}
function nowIso(): string {
  return new Date().toISOString();
}

function validateRequirementName(requirement: AgentSkillRequirement): void {
  if (requirement.kind === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(requirement.name)) throw new Error(`Invalid skill env requirement ${requirement.name}`);
  if (requirement.kind === 'command' && !/^[A-Za-z0-9._+-]+$/.test(requirement.name)) throw new Error(`Invalid skill command requirement ${requirement.name}`);
}

function normalizeRequirements(values: readonly AgentSkillRequirement[] | undefined): AgentSkillRequirement[] {
  const seen = new Set<string>();
  const result: AgentSkillRequirement[] = [];
  for (const value of values ?? []) {
    const kind: AgentSkillRequirementKind | null = value.kind === 'env' || value.kind === 'command' ? value.kind : null;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!kind || !name) continue;
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    const requirement: AgentSkillRequirement = { kind, name, ...(description ? { description } : {}) };
    validateRequirementName(requirement);
    const key = `${requirement.kind}:${requirement.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(requirement);
  }
  return result;
}

function parseReviewState(value: unknown): AgentSkillReviewState {
  return value === 'reviewed' || value === 'stale' || value === 'fresh' ? value : 'fresh';
}
function parseSource(value: unknown): AgentSkillSource {
  return value === 'agent' || value === 'imported' || value === 'system' ? value : 'user';
}

function freshReviewPatch() {
  return { reviewState: 'fresh' as const, staleReason: undefined, reviewedAt: undefined };
}
function reviewedReviewPatch() {
  return { reviewState: 'reviewed' as const, staleReason: undefined, reviewedAt: nowIso() };
}
function staleReviewPatch(reason: string) {
  return { reviewState: 'stale' as const, staleReason: reason.trim() || 'Marked stale by user.' };
}

function commandExists(command: string, pathValue: string | undefined): boolean {
  if (!pathValue) return false;
  return pathValue.split(delimiter).filter(Boolean).some((entry) => {
    try { accessSync(join(entry, command), constants.X_OK); return true; } catch { return false; }
  });
}

// ---------------------------------------------------------------------------
// A skill file and GoodVibes' facts in its frontmatter
// ---------------------------------------------------------------------------

/** One line a frontmatter value can hold and read back unchanged. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["'[]+/, '').replace(/["'\]]+$/, '').trim();
}
/** A list item: one line, no comma (a comma would split it on the way back). */
function listItem(value: string): string {
  return oneLine(value).replace(/,/g, ';');
}

function scalar(value: SkillFrontmatterValue | undefined): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.join(', ') : '';
}
function list(value: SkillFrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  return (typeof value === 'string' ? value.split(',') : [...value]).map((item) => item.trim()).filter(Boolean);
}

/** `NAME` or `NAME (what it is for)`, as a requirement is written into a list item. */
function requirementItem(requirement: AgentSkillRequirement): string {
  return listItem(requirement.description ? `${requirement.name} (${requirement.description})` : requirement.name);
}
function requirementsOf(kind: AgentSkillRequirementKind, value: SkillFrontmatterValue | undefined): AgentSkillRequirement[] {
  return list(value).flatMap((item) => {
    const match = /^(\S+)(?:\s+\((.*)\))?$/.exec(item);
    if (!match) return [];
    const requirement: AgentSkillRequirement = { kind, name: match[1]!, ...(match[2]?.trim() ? { description: match[2].trim() } : {}) };
    try { validateRequirementName(requirement); return [requirement]; } catch { return []; }
  });
}

interface Located {
  readonly record: AgentSkillRecord;
  readonly path: string;
  readonly origin: SkillOrigin;
  readonly format: 'file' | 'folder';
  /** The author's own frontmatter keys, kept on every rewrite. */
  readonly authorMetadata: Readonly<Record<string, SkillFrontmatterValue>>;
  /** The document as read, for the rewrite check. */
  readonly text: string;
}

function recordOf(name: string, description: string, body: string, metadata: Readonly<Record<string, SkillFrontmatterValue>>, updatedAt: number, located: { path: string; origin: SkillOrigin }): AgentSkillRecord {
  const marked = metadata['review'] !== undefined || metadata['enabled'] !== undefined;
  const fileTime = new Date(updatedAt || Date.now()).toISOString();
  const staleReason = scalar(metadata['stale-reason']).trim();
  const reviewedAt = scalar(metadata['reviewed-at']).trim();
  return {
    id: name,
    name: scalar(metadata['title']).trim() || name,
    description: description || scalar(metadata['summary']) || name,
    procedure: body,
    triggers: list(metadata['triggers']),
    tags: list(metadata['tags']),
    requirements: normalizeRequirementsLenient([...requirementsOf('env', metadata['requires-env'] ?? metadata['requiresEnv'] ?? metadata['requires_env']), ...requirementsOf('command', metadata['requires-commands'] ?? metadata['requiresCommands'] ?? metadata['requires_commands'])]),
    enabled: scalar(metadata['enabled']).trim().toLowerCase() === 'yes' || scalar(metadata['enabled']).trim().toLowerCase() === 'true',
    source: marked ? parseSource(scalar(metadata['source'])) : 'imported',
    provenance: scalar(metadata['provenance']).trim() || (marked ? 'user' : `File (${located.origin}): ${located.path}`),
    reviewState: parseReviewState(scalar(metadata['review']).trim()),
    ...(staleReason ? { staleReason } : {}),
    createdAt: scalar(metadata['created-at']).trim() || fileTime,
    updatedAt: scalar(metadata['updated-at']).trim() || fileTime,
    ...(reviewedAt ? { reviewedAt } : {}),
    path: located.path,
    origin: located.origin,
    marked,
    ...skillAuthorField(skillAuthorOf(metadata)),
  };
}

/**
 * The author kept in a skill file's frontmatter. No `author` key: none (the owner's; a file he dropped in or one from
 * before authors were kept). An `author` that is not one of the three reads as someone else's, waiting.
 */
function skillAuthorOf(metadata: Readonly<Record<string, SkillFrontmatterValue>>): MemoryAuthor | undefined {
  if (metadata['author'] === undefined) return undefined;
  const acceptedAt = Number(scalar(metadata['author-accepted-at']).trim());
  const who = scalar(metadata['author-who']).trim();
  return readRecordAuthor({
    kind: scalar(metadata['author']).trim(),
    ...(who ? { who } : {}),
    ...(scalar(metadata['author-accepted-at']).trim() && Number.isFinite(acceptedAt) ? { acceptedAt } : {}),
  });
}

function skillAuthorField(author: MemoryAuthor | undefined): { author?: MemoryAuthor } {
  return author === undefined ? {} : { author };
}

function normalizeRequirementsLenient(values: readonly AgentSkillRequirement[]): AgentSkillRequirement[] {
  try { return normalizeRequirements(values); } catch { return []; }
}

/** GoodVibes' facts about a record, as frontmatter values that read back unchanged. */
function marksOf(record: AgentSkillRecord): Record<string, SkillFrontmatterValue> {
  const marks: Record<string, SkillFrontmatterValue> = {};
  if (oneLine(record.name) !== record.id) marks['title'] = oneLine(record.name);
  marks['enabled'] = record.enabled ? 'yes' : 'no';
  marks['review'] = record.reviewState;
  if (record.triggers.length > 0) marks['triggers'] = record.triggers.map(listItem).filter(Boolean);
  if (record.tags.length > 0) marks['tags'] = record.tags.map(listItem).filter(Boolean);
  const env = record.requirements.filter((requirement) => requirement.kind === 'env');
  const commands = record.requirements.filter((requirement) => requirement.kind === 'command');
  if (env.length > 0) marks['requires-env'] = env.map(requirementItem);
  if (commands.length > 0) marks['requires-commands'] = commands.map(requirementItem);
  marks['source'] = record.source;
  if (oneLine(record.provenance)) marks['provenance'] = oneLine(record.provenance);
  if (record.staleReason && oneLine(record.staleReason)) marks['stale-reason'] = oneLine(record.staleReason);
  if (record.reviewedAt) marks['reviewed-at'] = record.reviewedAt;
  marks['created-at'] = record.createdAt;
  marks['updated-at'] = record.updatedAt;
  if (record.author) {
    marks['author'] = record.author.kind;
    if (record.author.who && oneLine(record.author.who)) marks['author-who'] = oneLine(record.author.who);
    if (record.author.acceptedAt !== undefined) marks['author-accepted-at'] = String(record.author.acceptedAt);
  }
  return marks;
}

function documentOf(record: AgentSkillRecord, authorMetadata: Readonly<Record<string, SkillFrontmatterValue>>): string {
  const metadata = { ...authorMetadata, ...marksOf(record) };
  const description = oneLine(record.description);
  const problem = skillContentProblem(description, metadata);
  if (problem) throw new Error(`Skill ${record.id} cannot be written: ${problem}.`);
  return serializeSkill({ name: record.id, description, metadata, body: record.procedure });
}

/** Every skill in the roots, the first of each name (case does not matter) as every reader sees it. */
function scanRoots(roots: readonly SkillRoot[]): Located[] {
  const seen = new Set<string>();
  const out: Located[] = [];
  for (const root of roots) {
    let entries: string[];
    try { entries = readdirSync(root.directory).sort((a, b) => a.localeCompare(b)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT' || (error as NodeJS.ErrnoException | null)?.code === 'ENOTDIR') continue;
      throw new Error(`The skill folder ${root.directory} could not be read: ${error instanceof Error ? error.message : String(error)}.`);
    }
    for (const entry of entries) {
      const isFile = entry.endsWith(SKILL_FILE_SUFFIX);
      const path = isFile ? join(root.directory, entry) : join(root.directory, entry, FOLDER_DOCUMENT);
      let text: string;
      let mtime: number;
      try {
        const info = statSync(path);
        if (!info.isFile()) continue;
        text = readFileSync(path, 'utf-8');
        mtime = info.mtimeMs;
      } catch { continue; }
      const parsed = parseSkill(text, mtime);
      const name = parsed.name.trim() || (isFile ? entry.slice(0, -SKILL_FILE_SUFFIX.length) : entry);
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const authorMetadata = Object.fromEntries(Object.entries(parsed.metadata).filter(([key2]) => !MARK_KEY_SET.has(key2)));
      out.push({ record: recordOf(name, parsed.description, parsed.body, parsed.metadata, mtime, { path, origin: root.origin }), path, origin: root.origin, format: isFile ? 'file' : 'folder', authorMetadata, text });
    }
  }
  return out.sort((left, right) => compareSkillsByOrigin({ origin: left.origin, name: left.record.id }, { origin: right.origin, name: right.record.id }));
}

// ---------------------------------------------------------------------------
// The library file: bundles, the revision, and what was carried
// ---------------------------------------------------------------------------

interface LibraryFile {
  readonly exists: boolean;
  readonly bundles: AgentSkillBundleRecord[];
  /** Bundles this build cannot read, written back as found. */
  readonly keptAsFound: unknown[];
  readonly fields: Record<string, unknown>;
}

function parseBundle(value: unknown): AgentSkillBundleRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const name = normalizeName(readString(value.name));
  const description = readString(value.description).trim();
  const skillIds = normalizeList(readStringArray(value.skillIds));
  if (!id || !name || !description || skillIds.length === 0) return null;
  const staleReason = readString(value.staleReason).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  return {
    id, name, description, skillIds,
    enabled: value.enabled === true,
    source: parseSource(value.source),
    provenance: readString(value.provenance, readString(value.source, 'user')).trim() || 'user',
    reviewState: parseReviewState(value.reviewState),
    ...(staleReason ? { staleReason } : {}),
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
    ...(reviewedAt ? { reviewedAt } : {}),
    ...skillAuthorField(readRecordAuthor(value.author)),
  };
}

function readLibraryFile(path: string): LibraryFile {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { exists: false, bundles: [], keptAsFound: [], fields: {} };
    throw new Error(`The skill library at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`The skill library at ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); repair or move it, then try again.`);
  }
  if (!isRecord(parsed)) throw new Error(`The skill library at ${path} is not a JSON object; repair or move it, then try again.`);
  const { version, bundles: rawBundles, ...fields } = parsed;
  if (typeof version === 'number' && version > LIBRARY_VERSION) {
    throw new Error(`The skill library at ${path} was written by a newer GoodVibes (file version ${version}); update GoodVibes, then try again.`);
  }
  const bundles: AgentSkillBundleRecord[] = [];
  const keptAsFound: unknown[] = [];
  for (const value of Array.isArray(rawBundles) ? rawBundles : []) {
    const bundle = parseBundle(value);
    if (bundle) bundles.push(bundle); else keptAsFound.push(value);
  }
  return { exists: true, bundles, keptAsFound, fields };
}

// ---------------------------------------------------------------------------
// A skill that comes from a project's files is the project's
// ---------------------------------------------------------------------------

/**
 * What the owner accepted of a skill that comes from a project's files (`project-local`), kept in this library file
 * by the file's path, never in the file: the file's own `enabled`, `review`, `reviewed-at`, `author` and `source` are a
 * repository's words and are ignored. Valid only while the file's content is the one he accepted (its hash): a changed
 * file is the project's again, switched off and waiting.
 */
interface ProjectSkillAcceptance {
  readonly hash: string;
  readonly enabled: boolean;
  readonly reviewState: AgentSkillReviewState;
  readonly reviewedAt?: string | undefined;
  readonly staleReason?: string | undefined;
  readonly author?: MemoryAuthor | undefined;
}

const PROJECT_ACCEPTED_FIELD = 'projectAccepted';

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function projectAcceptances(fields: Readonly<Record<string, unknown>>): Record<string, ProjectSkillAcceptance> {
  const kept = fields[PROJECT_ACCEPTED_FIELD];
  if (!isRecord(kept)) return {};
  const out: Record<string, ProjectSkillAcceptance> = {};
  for (const [path, value] of Object.entries(kept)) {
    if (!isRecord(value) || typeof value.hash !== 'string') continue;
    const reviewedAt = readString(value.reviewedAt).trim();
    const staleReason = readString(value.staleReason).trim();
    out[path] = {
      hash: value.hash, enabled: value.enabled === true, reviewState: parseReviewState(value.reviewState),
      ...(reviewedAt ? { reviewedAt } : {}), ...(staleReason ? { staleReason } : {}),
      ...skillAuthorField(value.author === undefined ? undefined : readRecordAuthor(value.author)),
    };
  }
  return out;
}

/** The project a skill file of a project's skill folder belongs to, named for the owner (`<project>/.goodvibes/skills/x.md`). */
function projectOfSkillFile(path: string): string {
  const marker = '/.goodvibes/';
  const at = path.indexOf(marker);
  return at > 0 ? path.slice(0, at) : dirname(path);
}

/**
 * A skill read from a project's files, as the store keeps it: the project's (author: someone else, the project), shown
 * as from the project, switched off and waiting for review unless the owner accepted this very content
 * (`projectAccepted`), whatever its frontmatter claims.
 */
function asProjectSkill(entry: Located, accepted: Readonly<Record<string, ProjectSkillAcceptance>>, homeDirectory: string): Located {
  const project = projectOfSkillFile(entry.path);
  const projectAuthor: MemoryAuthor = { kind: 'other', who: `the project ${project}` };
  const acceptance = accepted[entry.path];
  // Used only as the project's trust allows: a project the owner has not trusted (or keeps restricted) gives none.
  const trusted = projectFilesHeld(project, homeDirectory) === undefined;
  const current = trusted && acceptance !== undefined && acceptance.hash === contentHash(entry.text) ? acceptance : undefined;
  const { staleReason: _stale, reviewedAt: _reviewed, author: _author, ...rest } = entry.record;
  const record: AgentSkillRecord = {
    ...rest,
    source: 'imported',
    provenance: `From the project's files (${entry.path})${current ? '' : ', not accepted by you yet'}`,
    enabled: current?.enabled ?? false,
    reviewState: current?.reviewState ?? 'fresh',
    ...(current?.reviewedAt ? { reviewedAt: current.reviewedAt } : {}),
    ...(current?.staleReason ? { staleReason: current.staleReason } : {}),
    author: current?.author ?? projectAuthor,
  };
  return { ...entry, record };
}

/**
 * Whether a turn's skill reader (the model's registry tool, a typed trigger) may load a skill found on disk: one from a
 * project's files only when the owner accepted this very content, switched it on and reviewed it (the library's
 * `projectAccepted`, never the file's own frontmatter); any other as `skillMayLoad` says. `homeDirectory` is the home
 * whose `.goodvibes` holds the library.
 */
export function locatedSkillMayLoad(skill: { readonly origin: SkillOrigin; readonly path: string; readonly metadata: Readonly<Record<string, SkillFrontmatterValue>> }, homeDirectory: string | undefined): boolean {
  if (skill.origin !== 'project-local') return skillMayLoad(skill.metadata);
  if (!homeDirectory || projectFilesHeld(projectOfSkillFile(skill.path), homeDirectory) !== undefined) return false;
  try {
    const acceptance = projectAcceptances(readLibraryFile(skillLibraryPath(join(homeDirectory, '.goodvibes'))).fields)[skill.path];
    if (!acceptance || acceptance.hash !== contentHash(readFileSync(skill.path, 'utf-8'))) return false;
    return acceptance.enabled && acceptance.reviewState === 'reviewed' && acceptance.author !== undefined && !memoryAwaitsOwner({ author: acceptance.author });
  } catch {
    return false;
  }
}

function writeLibraryFile(path: string, read: LibraryFile, bundles: readonly AgentSkillBundleRecord[], fields: Record<string, unknown>, effects?: SkillLibraryWriteEffects): void {
  const revision = typeof fields['revision'] === 'number' ? fields['revision'] + 1 : 1;
  const text = `${JSON.stringify({ version: LIBRARY_VERSION, ...fields, revision, bundles: [...bundles, ...read.keptAsFound] }, null, 2)}\n`;
  atomicWriteFileSync(path, text, { ...effects, mkdirp: true, mode: 0o644 });
}

// ---------------------------------------------------------------------------
// Carrying the Agent's own store (3.5.0 and earlier) in, once
// ---------------------------------------------------------------------------

/** The Agent's skill store of 3.5.0 and earlier, under a home's `.goodvibes` folder. */
export function agentSkillStorePath(goodvibesRoot: string): string {
  return join(goodvibesRoot, 'agent', 'skills', 'skills.json');
}

function parseAgentSkill(value: unknown): AgentSkillRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const name = normalizeName(readString(value.name));
  const description = readString(value.description).trim();
  const procedure = readString(value.procedure).trim();
  if (!id || !name || !description || !procedure) return null;
  const staleReason = readString(value.staleReason).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  const requirements = Array.isArray(value.requirements) ? normalizeRequirementsLenient(value.requirements.filter(isRecord).map((entry) => ({
    kind: entry.kind === 'command' ? 'command' as const : 'env' as const,
    name: readString(entry.name).trim(),
    ...(readString(entry.description).trim() ? { description: readString(entry.description).trim() } : {}),
  }))) : [];
  return {
    id, name, description, procedure,
    triggers: readStringArray(value.triggers), tags: readStringArray(value.tags), requirements,
    enabled: value.enabled === true,
    source: parseSource(value.source),
    provenance: readString(value.provenance, readString(value.source, 'user')).trim() || 'user',
    reviewState: parseReviewState(value.reviewState),
    ...(staleReason ? { staleReason } : {}),
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
    ...(reviewedAt ? { reviewedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

export interface SkillLibraryOptions {
  /** The skill folders, in search order (resolveSkillRoots). */
  readonly roots: readonly SkillRoot[];
  /** The home's `.goodvibes` folder: new skills go to its `skills` folder, the library file sits there too. */
  readonly goodvibesRoot: string;
  readonly effects?: SkillLibraryWriteEffects | undefined;
}

interface State {
  readonly skills: readonly Located[];
  readonly library: LibraryFile;
}

/** Where a home's library file is: what a change advances, and what a tool call's checks watch. */
export function skillLibraryPath(goodvibesRoot: string): string {
  return join(goodvibesRoot, 'skills', SKILL_LIBRARY_FILE);
}

const COPIED_FROM = 'Copied from the file ';

/** The provenance a copy taken in from a file found on disk carries: it names that file. */
export function copiedFromProvenance(originalPath: string): string {
  return `${COPIED_FROM}${originalPath}`;
}

/**
 * Whether a skill file found on disk (not yet carrying GoodVibes' facts) was already copied into the store:
 * a skill of the store names its path as where it was copied from. Such a file is not offered as found again.
 */
export function wasCopiedIn(found: AgentSkillRecord, skills: readonly AgentSkillRecord[]): boolean {
  return found.marked !== true && found.path !== undefined && skills.some((skill) => skill.marked === true && skill.provenance === copiedFromProvenance(found.path!));
}

export class SkillLibrary {
  private readonly roots: readonly SkillRoot[];
  private readonly goodvibesRoot: string;
  private readonly createIn: string;
  private readonly libraryPath: string;
  private readonly effects: SkillLibraryWriteEffects | undefined;
  private held: State | null = null;
  /** The Agent's 3.5.0 store was carried in (or there was none) when this library last looked. */
  private carried = false;

  public constructor(options: SkillLibraryOptions) {
    this.roots = options.roots;
    this.goodvibesRoot = resolve(options.goodvibesRoot);
    this.createIn = join(this.goodvibesRoot, 'skills');
    this.libraryPath = skillLibraryPath(this.goodvibesRoot);
    this.effects = options.effects;
  }

  /**
   * The library a program's turns read: the project's skill folders and the home's, for `surfaceRoot`
   * (`agent`, `tui`). `goodvibesRoot` is the home's `.goodvibes` folder (GOODVIBES_HOME moves it).
   */
  public static forPaths(paths: { readonly workingDirectory?: string | undefined; readonly goodvibesRoot: string; readonly surfaceRoot: string }, effects?: SkillLibraryWriteEffects): SkillLibrary {
    const roots = resolveSkillRoots({ workingDirectory: paths.workingDirectory, homeDirectory: dirname(resolve(paths.goodvibesRoot)) }, paths.surfaceRoot);
    return new SkillLibrary({ roots, goodvibesRoot: paths.goodvibesRoot, ...(effects ? { effects } : {}) });
  }

  /** The folder new skills are written to. */
  public get folder(): string {
    return this.createIn;
  }

  /**
   * The store, with the one rule for what a turn applies: a bundle is active when
   * it is enabled, reviewed, setup-ready and every member is reviewed; a skill is
   * active when it is enabled or in an active bundle, and is itself reviewed and
   * setup-ready. The prompt, its receipts and every "active" listing read these two lists.
   */
  public snapshot(): AgentSkillSnapshot {
    const state = this.read();
    const skills = state.skills.map((entry) => entry.record);
    const bundles = state.library.bundles;
    const enabledSkills = skills.filter((skill) => skill.enabled);
    const enabledBundles = bundles.filter((bundle) => bundle.enabled);
    // Reviewed, and not someone else's words the owner has not accepted (state/memory-author.ts, the one rule).
    const given = (record: { readonly reviewState: AgentSkillReviewState; readonly author?: MemoryAuthor | undefined }): boolean =>
      record.reviewState === 'reviewed' && !memoryAwaitsOwner(record);
    const activeBundles = enabledBundles.filter((bundle) => {
      if (!given(bundle)) return false;
      const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
      return readiness.ready && readiness.includedSkills.every(given);
    });
    const applied = new Set<string>([...enabledSkills.map((skill) => skill.id), ...activeBundles.flatMap((bundle) => bundle.skillIds)]);
    return {
      path: this.libraryPath,
      skills,
      enabledSkills,
      bundles: [...bundles],
      enabledBundles,
      activeBundles,
      activeSkills: skills.filter((skill) => applied.has(skill.id) && given(skill) && evaluateAgentSkillReadiness(skill).ready),
    };
  }

  public list(): readonly AgentSkillRecord[] {
    return this.read().skills.map((entry) => entry.record);
  }

  public search(query: string): readonly AgentSkillRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((skill) => [skill.id, skill.name, skill.description, skill.procedure, ...skill.tags, ...skill.triggers]
      .some((field) => field.toLowerCase().includes(normalized)));
  }

  public listBundles(): readonly AgentSkillBundleRecord[] {
    return [...this.read().library.bundles];
  }

  public searchBundles(query: string): readonly AgentSkillBundleRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.listBundles();
    return this.listBundles().filter((bundle) => [bundle.id, bundle.name, bundle.description, ...bundle.skillIds]
      .some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrName: string): AgentSkillRecord | null {
    return this.find(this.read(), idOrName)?.record ?? null;
  }

  public getBundle(idOrName: string): AgentSkillBundleRecord | null {
    return this.findBundle(this.read(), idOrName);
  }

  /**
   * `reviewed`: trusted callers only, for text shipped in this build (a
   * built-in profile starter); everything else starts fresh and waits for review.
   */
  public create(input: AgentSkillCreateInput, options: { readonly reviewed?: boolean } = {}): AgentSkillRecord {
    return this.locked((state) => {
      const name = normalizeName(input.name);
      const description = normalizeDescription(input.description);
      const procedure = input.procedure.trim();
      this.validateRequired(name, description, procedure);
      const requirements = normalizeRequirements(input.requirements);
      assertNoSecretLikeText([name, description, procedure, ...(input.tags ?? []), ...(input.triggers ?? []), ...requirements.flatMap((requirement) => [requirement.name, requirement.description ?? ''])], 'Skills');
      const duplicate = state.skills.find((entry) => entry.record.name.toLowerCase() === name.toLowerCase() || entry.record.id.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill already exists ${duplicate.record.id}`);
      const timestamp = nowIso();
      const id = this.nextName(slugify(name), state);
      const record: AgentSkillRecord = {
        id, name, description, procedure,
        triggers: normalizeList(input.triggers), tags: normalizeList(input.tags), requirements,
        enabled: input.enabled === true,
        source: input.source ?? 'user',
        provenance: input.provenance?.trim() || input.source || 'user',
        ...(options.reviewed ? reviewedReviewPatch() : { reviewState: 'fresh' as const }),
        createdAt: timestamp, updatedAt: timestamp,
        ...skillAuthorField(newRecordAuthor(input.author)),
      };
      const path = join(this.createIn, `${id}${SKILL_FILE_SUFFIX}`);
      this.writeSkillFile(path, documentOf(record, {}));
      this.touchLibrary(state, state.library.bundles);
      return { ...record, path, origin: this.originOf(this.createIn), marked: true };
    });
  }

  public createBundle(input: AgentSkillBundleCreateInput): AgentSkillBundleRecord {
    return this.locked((state) => {
      const name = normalizeName(input.name);
      const description = input.description.trim();
      const skillIds = this.existingSkillIds(state, input.skillIds);
      this.validateBundleRequired(name, description, skillIds);
      assertNoSecretLikeText([name, description, ...skillIds], 'Skill bundles');
      const duplicate = state.library.bundles.find((bundle) => bundle.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill bundle already exists ${duplicate.id}`);
      const timestamp = nowIso();
      const bundle: AgentSkillBundleRecord = {
        id: nextId(slugify(name), new Set(state.library.bundles.map((entry) => entry.id))),
        name, description, skillIds,
        enabled: input.enabled === true,
        source: input.source ?? 'user',
        provenance: input.provenance?.trim() || input.source || 'user',
        reviewState: 'fresh', createdAt: timestamp, updatedAt: timestamp,
        ...skillAuthorField(newRecordAuthor(input.author)),
      };
      this.touchLibrary(state, [...state.library.bundles, bundle]);
      return bundle;
    });
  }

  public update(idOrName: string, input: AgentSkillUpdateInput): AgentSkillRecord {
    return this.changeSkill(idOrName, (existing, state) => {
      const name = input.name === undefined ? existing.name : normalizeName(input.name);
      const description = input.description === undefined ? existing.description : normalizeDescription(input.description);
      const procedure = input.procedure === undefined ? existing.procedure : input.procedure.trim();
      this.validateRequired(name, description, procedure);
      const requirements = input.requirements === undefined ? existing.requirements : normalizeRequirements(input.requirements);
      assertNoSecretLikeText([name, description, procedure, ...(input.tags ?? []), ...(input.triggers ?? []), ...requirements.flatMap((requirement) => [requirement.name, requirement.description ?? ''])], 'Skills');
      // Only a new name can clash (a skill carried in may share its title with another file already).
      const duplicate = input.name === undefined ? undefined : state.skills.find((entry) => entry.record.id !== existing.id && entry.record.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill already exists ${duplicate.record.id}`);
      return {
        ...existing, name, description, procedure,
        triggers: input.triggers === undefined ? existing.triggers : normalizeList(input.triggers),
        tags: input.tags === undefined ? existing.tags : normalizeList(input.tags),
        requirements,
        enabled: input.enabled ?? existing.enabled,
        provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
        ...freshReviewPatch(),
        updatedAt: nowIso(),
        ...skillAuthorField(authorAfterChange(existing.author, input.by, Date.now())),
      };
    });
  }

  public updateBundle(idOrName: string, input: AgentSkillBundleUpdateInput): AgentSkillBundleRecord {
    return this.changeBundle(idOrName, (existing, state) => {
      const name = input.name === undefined ? existing.name : normalizeName(input.name);
      const description = input.description === undefined ? existing.description : input.description.trim();
      const skillIds = input.skillIds === undefined ? existing.skillIds : this.existingSkillIds(state, input.skillIds);
      this.validateBundleRequired(name, description, skillIds);
      assertNoSecretLikeText([name, description, ...skillIds], 'Skill bundles');
      const duplicate = state.library.bundles.find((bundle) => bundle.id !== existing.id && bundle.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill bundle already exists ${duplicate.id}`);
      return {
        ...existing, name, description, skillIds,
        enabled: input.enabled ?? existing.enabled,
        provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
        ...freshReviewPatch(),
        updatedAt: nowIso(),
        ...skillAuthorField(authorAfterChange(existing.author, input.by, Date.now())),
      };
    });
  }

  public setEnabled(idOrName: string, enabled: boolean): AgentSkillRecord {
    return this.changeSkill(idOrName, (existing) => ({ ...existing, enabled, updatedAt: nowIso() }), true);
  }

  public setBundleEnabled(idOrName: string, enabled: boolean): AgentSkillBundleRecord {
    return this.changeBundle(idOrName, (existing) => ({ ...existing, enabled, updatedAt: nowIso() }));
  }

  /** `accept`: the owner himself reviewed it, which accepts a skill someone else wrote (never a model's review). */
  public markReviewed(idOrName: string, options: { readonly accept?: boolean } = {}): AgentSkillRecord {
    return this.changeSkill(idOrName, (existing) => ({
      ...existing, ...reviewedReviewPatch(), updatedAt: nowIso(),
      ...skillAuthorField(options.accept === true ? acceptedAuthor(existing.author, Date.now()) : existing.author),
    }), true);
  }

  public markBundleReviewed(idOrName: string, options: { readonly accept?: boolean } = {}): AgentSkillBundleRecord {
    return this.changeBundle(idOrName, (existing) => ({
      ...existing, ...reviewedReviewPatch(), updatedAt: nowIso(),
      ...skillAuthorField(options.accept === true ? acceptedAuthor(existing.author, Date.now()) : existing.author),
    }));
  }

  public markStale(idOrName: string, reason: string): AgentSkillRecord {
    return this.changeSkill(idOrName, (existing) => ({ ...existing, ...staleReviewPatch(reason), updatedAt: nowIso() }), true);
  }

  public markBundleStale(idOrName: string, reason: string): AgentSkillBundleRecord {
    return this.changeBundle(idOrName, (existing) => ({ ...existing, ...staleReviewPatch(reason), updatedAt: nowIso() }));
  }

  /**
   * Deletes a skill (its file, or its folder with what the folder holds) and takes it
   * out of every bundle in the same change. A bundle left with no member is removed; a
   * bundle that keeps other members goes back to stale review, so it applies again only
   * after someone reviews the new set.
   */
  public deleteSkill(idOrName: string): AgentSkillDeleteResult {
    return this.locked((state) => {
      const found = this.find(state, idOrName);
      if (!found) throw new Error(`Unknown skill ${idOrName}`);
      const existing = found.record;
      const removedBundles: AgentSkillBundleRecord[] = [];
      const changedBundles: AgentSkillBundleRecord[] = [];
      const bundles: AgentSkillBundleRecord[] = [];
      const timestamp = nowIso();
      for (const bundle of state.library.bundles) {
        if (!bundle.skillIds.includes(existing.id)) { bundles.push(bundle); continue; }
        const skillIds = bundle.skillIds.filter((skillId) => skillId !== existing.id);
        if (skillIds.length === 0) { removedBundles.push(bundle); continue; }
        const changed: AgentSkillBundleRecord = { ...bundle, skillIds, ...staleReviewPatch(`member skill ${existing.id} was deleted`), updatedAt: timestamp };
        changedBundles.push(changed);
        bundles.push(changed);
      }
      this.effects?.assertCurrent?.();
      rmSync(found.format === 'folder' ? dirname(found.path) : found.path, { recursive: true, force: true });
      this.effects?.onEffect?.(true);
      this.touchLibrary(state, bundles);
      return { skill: existing, removedBundles, changedBundles };
    });
  }

  public deleteBundle(idOrName: string): AgentSkillBundleRecord {
    return this.locked((state) => {
      const existing = this.findBundle(state, idOrName);
      if (!existing) throw new Error(`Unknown skill bundle ${idOrName}`);
      this.touchLibrary(state, state.library.bundles.filter((bundle) => bundle.id !== existing.id));
      return existing;
    });
  }

  /**
   * Import a skill from the open skill standard format (SKILL.md), switched off and
   * waiting for review. Throws if the content is invalid or holds secret-looking text.
   */
  public importFromStandard(content: string, author?: MemoryAuthor): AgentSkillRecord {
    const parsed = parseSkillStandardMarkdown(content);
    if ('error' in parsed) throw new Error(parsed.error);
    return this.create({ name: parsed.name, description: parsed.description, procedure: parsed.body, enabled: false, source: 'imported', provenance: 'skill-standard-import', author });
  }

  /**
   * Copy a skill file found on disk into the store (`~/.goodvibes/skills`), under a name no skill uses, with
   * GoodVibes' facts written on the copy only: the file it was found in is never changed. A skill kept as a folder
   * is copied whole (its scripts and files beside SKILL.md). The copy waits for review; `enabled` switches it on.
   * Its provenance names the original (`copiedFromProvenance`), so the original is no longer offered as found.
   */
  public copyIn(idOrName: string, input: { readonly enabled: boolean; readonly source: AgentSkillSource; readonly author?: MemoryAuthor | undefined }): { readonly skill: AgentSkillRecord; readonly original: string } {
    return this.locked((state) => {
      const found = this.find(state, idOrName);
      if (!found) throw new Error(`Unknown skill ${idOrName}`);
      const problem = frontmatterRewriteProblem(found.text);
      if (problem) throw new Error(`The frontmatter of ${found.path} cannot be copied without loss (${problem}); copy that file into ${this.createIn} by hand.`);
      // Who copies it in is its author (the file on disk names nobody the daemon checked).
      const { staleReason: _staleReason, reviewedAt: _reviewedAt, path: _path, origin: _origin, marked: _marked, author: _author, ...original } = found.record;
      const id = this.nextName(slugify(original.id), state);
      const timestamp = nowIso();
      const record: AgentSkillRecord = {
        ...original, id,
        enabled: input.enabled, source: input.source, provenance: copiedFromProvenance(found.path),
        reviewState: 'fresh',
        createdAt: timestamp, updatedAt: timestamp,
        ...skillAuthorField(newRecordAuthor(input.author)),
      };
      const path = found.format === 'folder' ? join(this.createIn, id, FOLDER_DOCUMENT) : join(this.createIn, `${id}${SKILL_FILE_SUFFIX}`);
      const document = documentOf(record, found.authorMetadata);
      this.effects?.assertCurrent?.();
      // A folder's other files come along; its SKILL.md is then written with the facts.
      if (found.format === 'folder') cpSync(dirname(found.path), dirname(path), { recursive: true, errorOnExist: true, force: false });
      this.writeSkillFile(path, document);
      this.touchLibrary(state, state.library.bundles);
      return { skill: { ...record, path, origin: this.originOf(this.createIn), marked: true }, original: found.path };
    });
  }

  /** Export one skill as `<destDir>/<slug>/SKILL.md`; refuses an existing file unless `overwrite`. Returns the path written. */
  public exportToStandard(idOrName: string, destDir: string, overwrite = false): string {
    const skill = this.get(idOrName);
    if (!skill) throw new Error(`Unknown skill ${idOrName}`);
    const filePath = skillStandardFilePath(skill.name, destDir);
    if (!overwrite && existsSync(filePath)) throw new Error(`Skill file already exists at ${filePath}.`);
    atomicWriteFileSync(filePath, renderSkillStandardMarkdown(skill), { mkdirp: true, mode: 0o644 });
    return filePath;
  }

  /**
   * The skill written as a SKILL.md at exactly `filePath` (a capability resolving a folder the caller named through its
   * held handle, capabilities/held-paths.ts, which made its folder; or a folder still to be made); the path written.
   */
  public exportToStandardFile(idOrName: string, filePath: string, overwrite = false): string {
    const skill = this.get(idOrName);
    if (!skill) throw new Error(`Unknown skill ${idOrName}`);
    if (!overwrite && existsSync(filePath)) throw new Error(`Skill file already exists at ${filePath}.`);
    // The one way a capability writes a file (capabilities/held-paths.ts `writeHeldFiles`): beneath a folder a caller
    // named, by a pending name and rename inside the opened folder, so a link swapped in at SKILL.md is never followed.
    writeHeldFile(filePath, renderSkillStandardMarkdown(skill), 0o644);
    return filePath;
  }

  /** Nothing to report: a skill this version cannot read is a file it leaves alone. Kept for the callers that print it. */
  public lastWriteReport(): undefined {
    return undefined;
  }

  // -------------------------------------------------------------------------

  private originOf(directory: string): SkillOrigin {
    return this.roots.find((root) => resolve(root.directory) === resolve(directory))?.origin ?? 'custom';
  }

  private validateRequired(name: string, description: string, procedure: string): void {
    if (!name) throw new Error('Skill name is required.');
    if (!description) throw new Error('Skill description is required.');
    if (!procedure) throw new Error('Skill procedure is required.');
  }

  private validateBundleRequired(name: string, description: string, skillIds: readonly string[]): void {
    if (!name) throw new Error('Skill bundle name is required.');
    if (!description) throw new Error('Skill bundle description is required.');
    if (skillIds.length === 0) throw new Error('Skill bundle must include at least one existing skill.');
  }

  /** A file name no skill in any folder uses, so the new skill is never hidden by another of the same name. */
  private nextName(base: string, state: State): string {
    const taken = new Set(state.skills.map((entry) => entry.record.id.toLowerCase()));
    for (const root of this.roots) {
      for (const entry of safeList(root.directory)) taken.add(entry.replace(/\.md$/, '').toLowerCase());
    }
    return nextId(base, taken);
  }

  private find(state: State, idOrName: string): Located | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return state.skills.find((entry) => entry.record.id.toLowerCase() === lookup)
      ?? state.skills.find((entry) => entry.record.name.toLowerCase() === lookup) ?? null;
  }

  private findBundle(state: State, idOrName: string): AgentSkillBundleRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return state.library.bundles.find((bundle) => bundle.id.toLowerCase() === lookup || bundle.name.toLowerCase() === lookup) ?? null;
  }

  private existingSkillIds(state: State, skillIds: readonly string[]): readonly string[] {
    const ids: string[] = [];
    for (const wanted of normalizeList(skillIds)) {
      const found = this.find(state, wanted) ?? this.find(state, slugify(wanted));
      if (!found) throw new Error(`Unknown skill for bundle ${wanted}`);
      if (!ids.includes(found.record.id)) ids.push(found.record.id);
    }
    return ids;
  }

  private changeSkill(idOrName: string, change: (existing: AgentSkillRecord, state: State) => AgentSkillRecord, marksOnly = false): AgentSkillRecord {
    return this.locked((state) => {
      const found = this.find(state, idOrName);
      if (!found) throw new Error(`Unknown skill ${idOrName}`);
      const updated = change(found.record, state);
      if (found.origin === 'project-local' && marksOnly) {
        // The owner's switch, review or acceptance of a project's skill is kept here, for this content; the project's
        // file is never written with it (a mark there would be the repository's word again).
        this.keepProjectAcceptance(state, found.path, found.text, updated);
        this.touchLibrary(state, state.library.bundles);
        return { ...updated, marked: true };
      }
      // A frontmatter written by hand in fuller YAML than one key: value per line would lose what its author wrote.
      const problem = frontmatterRewriteProblem(found.text);
      if (problem) throw new Error(`The frontmatter of ${found.path} cannot be rewritten without loss (${problem}); change that file by hand.`);
      const document = documentOf(updated, found.authorMetadata);
      this.writeSkillFile(found.path, document);
      // A project's skill changed here: what was accepted is for the content as written now, by whom it says.
      if (found.origin === 'project-local') this.keepProjectAcceptance(state, found.path, document, updated);
      this.touchLibrary(state, state.library.bundles);
      return { ...updated, marked: true };
    });
  }

  /** Keep (in this library file) the owner's marks of a project's skill for exactly `text`, the file's content. */
  private keepProjectAcceptance(state: State, path: string, text: string, record: AgentSkillRecord): void {
    const fields = state.library.fields;
    const kept = isRecord(fields[PROJECT_ACCEPTED_FIELD]) ? { ...(fields[PROJECT_ACCEPTED_FIELD] as Record<string, unknown>) } : {};
    kept[path] = {
      hash: contentHash(text), enabled: record.enabled, reviewState: record.reviewState,
      ...(record.reviewedAt ? { reviewedAt: record.reviewedAt } : {}), ...(record.staleReason ? { staleReason: record.staleReason } : {}),
      ...(record.author ? { author: record.author } : {}),
    };
    fields[PROJECT_ACCEPTED_FIELD] = kept;
  }

  private changeBundle(idOrName: string, change: (existing: AgentSkillBundleRecord, state: State) => AgentSkillBundleRecord): AgentSkillBundleRecord {
    return this.locked((state) => {
      const existing = this.findBundle(state, idOrName);
      if (!existing) throw new Error(`Unknown skill bundle ${idOrName}`);
      const updated = change(existing, state);
      this.touchLibrary(state, state.library.bundles.map((bundle) => bundle.id === existing.id ? updated : bundle));
      return updated;
    });
  }

  private writeSkillFile(path: string, text: string): void {
    atomicWriteFileSync(path, text, { ...this.effects, mkdirp: true, mode: 0o644 });
  }

  /** Every change rewrites the library file, so a reader watching one file sees the store change. */
  private touchLibrary(state: State, bundles: readonly AgentSkillBundleRecord[]): void {
    writeLibraryFile(this.libraryPath, state.library, bundles, state.library.fields, this.effects);
  }

  private readState(): State {
    const library = readLibraryFile(this.libraryPath);
    // A skill from a project's files is the project's: what its frontmatter claims of an author, a review or a switch
    // is ignored; only the owner's acceptance kept here, for this very content, counts (asProjectSkill).
    const accepted = projectAcceptances(library.fields);
    const home = dirname(this.goodvibesRoot);
    return { skills: scanRoots(this.roots).map((entry) => entry.origin === 'project-local' ? asProjectSkill(entry, accepted, home) : entry), library };
  }

  /** A read: the files as they are now (the Agent's 3.5.0 store carried in first, once). */
  private read(): State {
    if (this.held) return this.held;
    this.carryAgentStore();
    return this.readState();
  }

  /** One locked change: the store is read once under the library's lock, and every write is made inside it. */
  private locked<T>(update: (state: State) => T): T {
    this.carryAgentStore();
    return withProcessLockSync(`${this.libraryPath}.writer.sqlite`, () => {
      this.held = this.readState();
      try { return update(this.held); }
      finally { this.held = null; }
    });
  }

  /**
   * Carry the Agent's 3.5.0 store (skills.json) into this one, once per home: each skill becomes a
   * file in the shared skill folder (under its own id, or `<id>-agent` when that name is taken), each
   * bundle a bundle here with its members' new names, the draft ledger beside it. Skills and bundles
   * this build cannot read are kept in the library file as found. The old file is not touched.
   */
  private carryAgentStore(): void {
    if (this.carried) return;
    const from = agentSkillStorePath(this.goodvibesRoot);
    if (!existsSync(from) || readLibraryFile(this.libraryPath).fields['carriedFromAgent'] !== undefined) {
      this.carried = true;
      return;
    }
    withProcessLockSync(`${this.libraryPath}.writer.sqlite`, () => {
      const current = readLibraryFile(this.libraryPath);
      if (current.fields['carriedFromAgent'] !== undefined) return;
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(from, 'utf-8')); }
      catch (error) {
        throw new Error(`The Agent's skill store at ${from} could not be read (${error instanceof Error ? error.message : String(error)}), so its skills were not carried into ${this.createIn}; repair or move that file, then try again.`);
      }
      const body = isRecord(raw) ? raw : {};
      const skills: AgentSkillRecord[] = [];
      const unreadSkills: unknown[] = [];
      for (const value of Array.isArray(body['skills']) ? body['skills'] : []) {
        const skill = parseAgentSkill(value);
        if (skill) skills.push(skill); else unreadSkills.push(value);
      }
      const bundles: AgentSkillBundleRecord[] = [];
      const unreadBundles: unknown[] = [];
      for (const value of Array.isArray(body['bundles']) ? body['bundles'] : []) {
        const bundle = parseBundle(value);
        if (bundle) bundles.push(bundle); else unreadBundles.push(value);
      }
      const present = scanRoots(this.roots);
      const taken = new Set(present.map((entry) => entry.record.id.toLowerCase()));
      for (const entry of safeList(this.createIn)) taken.add(entry.replace(/\.md$/, '').toLowerCase());
      const renamed: Record<string, string> = {};
      for (const skill of skills) {
        const base = slugify(skill.id);
        const name = taken.has(base.toLowerCase()) ? nextId(`${base}-agent`, taken) : base;
        taken.add(name.toLowerCase());
        renamed[skill.id] = name;
        const record: AgentSkillRecord = { ...skill, id: name };
        atomicWriteFileSync(join(this.createIn, `${name}${SKILL_FILE_SUFFIX}`), documentOf(record, {}), { mkdirp: true, mode: 0o644 });
      }
      const bundleIds = new Set(current.bundles.map((bundle) => bundle.id));
      const carriedBundles = bundles.map((bundle) => {
        const id = bundleIds.has(bundle.id) ? nextId(`${bundle.id}-agent`, bundleIds) : bundle.id;
        bundleIds.add(id);
        return { ...bundle, id, skillIds: bundle.skillIds.map((skillId) => renamed[skillId] ?? skillId) };
      });
      this.carryDraftLedger(renamed);
      const fields: Record<string, unknown> = {
        ...current.fields,
        carriedFromAgent: {
          at: nowIso(), from, skills: renamed, bundles: carriedBundles.map((bundle) => bundle.id),
          ...(unreadSkills.length > 0 ? { unreadSkills } : {}),
        },
      };
      writeLibraryFile(this.libraryPath, { ...current, keptAsFound: [...current.keptAsFound, ...unreadBundles] }, [...current.bundles, ...carriedBundles], fields);
    });
    this.carried = true;
  }

  /** The Agent's draft ledger (which learned procedures were already drafted) goes beside the library, its skill ids renamed. */
  private carryDraftLedger(renamed: Readonly<Record<string, string>>): void {
    const from = join(dirname(agentSkillStorePath(this.goodvibesRoot)), 'skill-draft-ledger.json');
    const to = join(this.createIn, 'skill-draft-ledger.json');
    if (!existsSync(from) || existsSync(to)) return;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(from, 'utf-8')); } catch { return; }
    if (!isRecord(raw)) return;
    const entries = Array.isArray(raw['entries']) ? raw['entries'].map((entry) => isRecord(entry) && typeof entry['skillId'] === 'string'
      ? { ...entry, skillId: renamed[entry['skillId']] ?? entry['skillId'] } : entry) : raw['entries'];
    atomicWriteFileSync(to, `${JSON.stringify({ ...raw, entries }, null, 2)}\n`, { mkdirp: true, mode: 0o644 });
  }
}

function safeList(directory: string): string[] {
  try { return readdirSync(directory); } catch { return []; }
}

function nextId(base: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((entry) => entry.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Could not find a free name for ${base}.`);
}

// ---------------------------------------------------------------------------
// The shared SKILL.md format
// ---------------------------------------------------------------------------

export interface SkillStandardParsed {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** Parse a SKILL.md in the open skill standard format: `name` and `description` are required. */
export function parseSkillStandardMarkdown(content: string): SkillStandardParsed | { readonly error: string } {
  const parsed = parseSkill(content.replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  const name = parsed.name.trim();
  const description = parsed.description.trim();
  if (!name) return { error: 'SKILL.md is missing required frontmatter field: name' };
  if (!description) return { error: 'SKILL.md is missing required frontmatter field: description' };
  const body = parsed.body.trim();
  try { assertNoSecretLikeText([name, description, body], 'Shared skill'); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Secret-looking content rejected.' }; }
  return { name, description, body };
}

export function renderSkillStandardMarkdown(skill: Pick<AgentSkillRecord, 'name' | 'description' | 'procedure'>): string {
  return `---\nname: ${skill.name}\ndescription: ${normalizeDescription(skill.description)}\n---\n${skill.procedure.trimEnd()}\n`;
}

/** Where a skill named `name` is exported under `destDir`: `<destDir>/<slug>/SKILL.md`. */
export function skillStandardFilePath(name: string, destDir: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('skill name produces an empty folder name');
  return join(destDir, slug, 'SKILL.md');
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export function buildAgentSkillRequirements(input: { readonly env?: readonly string[] | undefined; readonly commands?: readonly string[] | undefined }): readonly AgentSkillRequirement[] {
  return normalizeRequirements([
    ...(input.env ?? []).map((name) => ({ kind: 'env' as const, name })),
    ...(input.commands ?? []).map((name) => ({ kind: 'command' as const, name })),
  ]);
}

export function normalizeAgentSkillRequirements(values: readonly AgentSkillRequirement[] | undefined): readonly AgentSkillRequirement[] {
  return normalizeRequirements(values);
}

export function formatAgentSkillRequirement(requirement: AgentSkillRequirement): string {
  return `${requirement.kind}:${requirement.name}`;
}

export function evaluateAgentSkillReadiness(
  skill: Pick<AgentSkillRecord, 'requirements'>,
  options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly pathValue?: string | undefined } = {},
): AgentSkillReadiness {
  const env = options.env ?? process.env;
  const pathValue = options.pathValue ?? env.PATH;
  const met: AgentSkillRequirement[] = [];
  const missing: AgentSkillRequirement[] = [];
  for (const requirement of skill.requirements) {
    const present = requirement.kind === 'env'
      ? typeof env[requirement.name] === 'string' && (env[requirement.name] ?? '').length > 0
      : commandExists(requirement.name, pathValue);
    (present ? met : missing).push(requirement);
  }
  return { ready: missing.length === 0, met, missing };
}

export function evaluateAgentSkillBundleReadiness(
  bundle: Pick<AgentSkillBundleRecord, 'skillIds'>,
  skills: readonly AgentSkillRecord[],
  options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly pathValue?: string | undefined } = {},
): AgentSkillBundleReadiness {
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const includedSkills: AgentSkillRecord[] = [];
  const missingSkillIds: string[] = [];
  const missingRequirements: AgentSkillRequirement[] = [];
  const seen = new Set<string>();
  for (const skillId of bundle.skillIds) {
    const skill = skillById.get(skillId);
    if (!skill) { missingSkillIds.push(skillId); continue; }
    includedSkills.push(skill);
    for (const requirement of evaluateAgentSkillReadiness(skill, options).missing) {
      const key = `${requirement.kind}:${requirement.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      missingRequirements.push(requirement);
    }
  }
  return { ready: missingSkillIds.length === 0 && missingRequirements.length === 0, includedSkills, missingSkillIds, missingRequirements };
}

/**
 * Whether a turn's skill reader (the model's registry tool, a typed trigger) may load this skill: a file
 * that carries GoodVibes' facts loads only when it is switched on and reviewed; a file without them (one
 * written by hand) loads as it always has.
 */
export function skillMayLoad(metadata: Readonly<Record<string, SkillFrontmatterValue>>): boolean {
  const enabled = scalar(metadata['enabled']).trim().toLowerCase();
  const review = scalar(metadata['review']).trim().toLowerCase();
  if (!enabled && !review) return true;
  return (enabled === 'yes' || enabled === 'true') && review === 'reviewed';
}
