/**
 * memory-file-projection.ts, standing memory records as GIT-BACKED markdown
 * files that ROUND-TRIP through the confirmation-gated mutation path.
 *
 * The platform's memory should be inspectable and correctable as files. This
 * module projects standing (project/team-scope) MemoryRecords to one markdown
 * file per record under a git-backed directory, and reads user edits BACK, but
 * never as a silent write to the store. A user edit or deletion becomes a
 * PROPOSAL (a review-queue entry); the store is mutated only for proposals the
 * caller explicitly confirms, through the registry's own update/delete. The disk
 * file is a correction surface, not a second source of truth.
 *
 * Temporal validity (validFrom/validUntil) is projected into each file's
 * front-matter and its live status is labelled, an expired record is shown as
 * `status: expired`, not silently dropped from the projection.
 *
 * `sync` records what it wrote in `.projection-manifest.json` (record id to a
 * hash of the file it wrote). That manifest is how an unreviewed edit or a
 * deletion is told apart from a record the store gained since the last sync:
 * `sync` keeps a file the user changed, `diffProjectionToProposals` proposes a
 * delete only for an id the manifest says was projected. A file whose record
 * left the store (or the projected scopes) is removed by `sync` when the user
 * did not touch it, and kept and reported when they did; `review` lists such
 * files as orphans (`findOrphanedProjectionFiles`). The `cls`,
 * `confidence`, `reviewState` and `status` front-matter lines are read-only:
 * the memory update verbs cannot change them, so an edit there is not a proposal.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { MemoryClass, MemoryRecord, MemoryScope, MemoryTemporalStatus } from './memory-store.js';
import { memoryRecordTemporalStatus } from './memory-store.js';

/** Scopes eligible for the file projection, standing memory only (not per-session). */
const DEFAULT_PROJECTION_SCOPES: readonly MemoryScope[] = ['project', 'team'];

export interface MemoryProjectionOptions {
  /** Restrict projection to these scopes; defaults to project + team. */
  readonly scopes?: readonly MemoryScope[];
}

/**
 * Optional git seam: durably commit the projected files. Injectable for tests.
 *
 * The projection only ever commits to a repository it OWNS, one whose
 * toplevel is the projection directory itself, never a repository the
 * directory merely sits inside. `projectMemoryToFiles` enforces that policy:
 * it resolves the enclosing toplevel first, and when the directory is not its
 * own repository root (nested in a foreign checkout, or not in any repository
 * at all) it initializes a repository AT the projection directory before
 * staging. Without this, a projection under a temp/scratch path nested inside
 * a real checkout would commit into that checkout.
 */
export interface MemoryProjectionGit {
  /**
   * The toplevel directory git would resolve for `dir` (`git -C <dir>
   * rev-parse --show-toplevel`), or null when no repository encloses it.
   */
  resolveToplevel(dir: string): string | null;
  /** Initialize a repository whose root is exactly `dir`. */
  init(dir: string): void;
  add(dir: string): void;
  /** Returns false when the tree was unchanged and nothing was committed. */
  commit(dir: string, message: string): void | boolean;
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

/**
 * Production git seam for the memory projection: shells out to the system
 * git, commits with a neutral projection identity (never the operator's),
 * and tolerates an unchanged tree.
 */
export function createMemoryProjectionGit(): MemoryProjectionGit {
  const run = (args: readonly string[]): { ok: boolean; status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync('git', [...args], { encoding: 'utf-8', timeout: 30_000 });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
    };
  };
  return {
    resolveToplevel(dir: string): string | null {
      const result = run(['-C', dir, 'rev-parse', '--show-toplevel']);
      return result.ok && result.stdout.length > 0 ? result.stdout : null;
    },
    init(dir: string): void {
      const result = run(['init', dir]);
      if (!result.ok) {
        throw new Error(`memory projection git init failed for ${dir}: ${result.stderr || result.stdout}`);
      }
    },
    add(dir: string): void {
      const result = run(['-C', dir, 'add', '-A']);
      if (!result.ok) {
        throw new Error(`memory projection git add failed for ${dir}: ${result.stderr || result.stdout}`);
      }
    },
    commit(dir: string, message: string): boolean {
      // `diff --cached --quiet` exits 0 when nothing is staged and 1 when
      // something is: an unchanged tree skips the commit, and any commit
      // failure after that is a failure (git's messages are localized, so
      // they are never matched).
      const staged = run(['-C', dir, 'diff', '--cached', '--quiet']);
      if (staged.status === 0) return false;
      if (staged.status !== 1) {
        throw new Error(`memory projection git diff failed for ${dir}: ${staged.stderr || staged.stdout}`);
      }
      const result = run([
        '-C', dir,
        '-c', 'user.name=GoodVibes Memory Projection',
        '-c', 'user.email=memory-projection@goodvibes.local',
        'commit', '--no-verify', '-m', message,
      ]);
      if (!result.ok) {
        throw new Error(`memory projection git commit failed for ${dir}: ${result.stderr || result.stdout}`);
      }
      return true;
    },
  };
}

/** The parsed content of one projected markdown file. */
export interface MemoryProjectionFile {
  readonly id: string;
  readonly path: string;
  readonly scope?: MemoryScope | undefined;
  readonly cls?: MemoryClass | undefined;
  /** Read-only line as written in the file; parsed so a changed value is noticed, never proposed. */
  readonly confidence?: number | undefined;
  readonly reviewState?: string | undefined;
  readonly summary: string;
  readonly detail?: string | undefined;
  readonly tags: readonly string[];
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
}

export interface MemoryProjectionWriteReport {
  readonly dir: string;
  readonly written: readonly string[];
  /** Ids whose file was left as it is: the user edited or deleted it and has not reviewed that yet. */
  readonly kept?: readonly string[] | undefined;
  /** Ids whose record is gone from the store (or the projected scopes) and whose untouched file was removed. */
  readonly removed?: readonly string[] | undefined;
  /** Ids whose record is gone but whose file the user edited: the file is kept, and review lists it as an orphan. */
  readonly orphaned?: readonly string[] | undefined;
  readonly committed: boolean;
}

const MANIFEST_NAME = '.projection-manifest.json';

type ProjectionManifest = Readonly<Record<string, string>>;

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readManifest(dir: string): ProjectionManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf-8'));
    const files = typeof parsed === 'object' && parsed !== null ? (parsed as { files?: unknown }).files : undefined;
    if (typeof files !== 'object' || files === null) return null;
    const out: Record<string, string> = {};
    for (const [id, hash] of Object.entries(files)) if (typeof hash === 'string') out[id] = hash;
    return out;
  } catch {
    return null;
  }
}

/**
 * The ids the last `sync` projected, or null when this directory has no
 * manifest (it predates it, or was never synced). Pass it to
 * `diffProjectionToProposals` as `projectedIds` so a deleted file is proposed
 * as a deletion only for a record that had one.
 */
export function readProjectedMemoryIds(dir: string): ReadonlySet<string> | null {
  const manifest = readManifest(dir);
  return manifest ? new Set(Object.keys(manifest)) : null;
}

function selectStandingRecords(records: readonly MemoryRecord[], options: MemoryProjectionOptions): MemoryRecord[] {
  const scopes = new Set(options.scopes ?? DEFAULT_PROJECTION_SCOPES);
  return records
    .filter((record) => scopes.has(record.scope))
    .sort((left, right) => left.createdAt - right.createdAt);
}

function toIso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** The file holds a summary on one `# ` line, so a multi-line summary is compared and written collapsed. */
function normalizeSummary(summary: string): string {
  return summary.replace(/\s*\n\s*/g, ' ').trim();
}

/** Tags are written comma-separated; a tag the comma format cannot carry exactly switches the line to a JSON array. */
function formatTags(tags: readonly string[]): string {
  const plain = tags.join(', ');
  const lossy = tags.some((tag) => tag === '' || tag !== tag.trim() || /[,\n]/.test(tag)) || plain.startsWith('[');
  return lossy ? JSON.stringify(tags) : plain;
}

function parseTags(value: string): string[] {
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) return parsed;
    } catch { /* an edited line that is not valid JSON falls back to the comma form */ }
  }
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

/** Render one record as a markdown file body (front-matter + content). */
export function projectMemoryRecordToMarkdown(record: MemoryRecord, now: number = Date.now()): string {
  const status = memoryRecordTemporalStatus(record, now);
  const lines: string[] = ['---'];
  lines.push(`id: ${record.id}`);
  lines.push(`scope: ${record.scope}`);
  lines.push(`cls: ${record.cls}`);
  lines.push(`tags: ${formatTags(record.tags)}`);
  lines.push(`confidence: ${record.confidence}`);
  lines.push(`reviewState: ${record.reviewState}`);
  const validFrom = toIso(record.validFrom);
  const validUntil = toIso(record.validUntil);
  if (validFrom) lines.push(`validFrom: ${validFrom}`);
  if (validUntil) lines.push(`validUntil: ${validUntil}`);
  // The live temporal status, so an expired record is visibly labelled expired
  // in its own file rather than silently missing from injection.
  lines.push(`status: ${status}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${normalizeSummary(record.summary)}`);
  if (record.detail?.trim()) {
    lines.push('');
    lines.push(record.detail.trim());
  }
  lines.push('');
  return lines.join('\n');
}

function recordFileName(id: string): string {
  // ids are `mem_...` (safe filename chars); keep 1:1 with the id for round-trip.
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

/**
 * Project standing records to `<dir>/<id>.md`. Writes one file per in-scope
 * record, except one the user has changed since the last sync (an edit or a
 * deletion that has not been reviewed): that file is kept as it is and its id
 * is reported in `kept`, so a correction is never overwritten before it can
 * become a proposal. When a git seam is supplied, stages + commits the
 * directory so the projection is durable and diffable. A file the last sync
 * wrote for a record that is no longer in the store (or no longer in a
 * projected scope) is removed when its content is still what sync wrote, so
 * the directory never shows a memory that does not exist; when the user
 * edited it, it is kept and reported in `orphaned` (one manifest lookup per
 * such id, nothing else is read).
 */
export function projectMemoryToFiles(
  records: readonly MemoryRecord[],
  dir: string,
  options: MemoryProjectionOptions & { readonly now?: number; readonly git?: MemoryProjectionGit } = {},
): MemoryProjectionWriteReport {
  const now = options.now ?? Date.now();
  mkdirSync(dir, { recursive: true });
  const standing = selectStandingRecords(records, options);
  const previous: ProjectionManifest = readManifest(dir) ?? {};
  const next: Record<string, string> = {};
  const written: string[] = [];
  const kept: string[] = [];
  for (const record of standing) {
    const path = join(dir, recordFileName(record.id));
    const markdown = projectMemoryRecordToMarkdown(record, now);
    const lastHash = previous[record.id];
    if (lastHash !== undefined && !existsSync(path)) {
      // Projected before, and the file is gone: the user deleted it. Writing it
      // back would undo that before `review` can propose the deletion.
      next[record.id] = lastHash;
      kept.push(record.id);
      continue;
    }
    if (existsSync(path)) {
      const onDisk = readFileSync(path, 'utf-8');
      const changedSinceSync = lastHash === undefined || contentHash(onDisk) !== lastHash;
      const parsed = parseProjectedMemoryFile(path, onDisk);
      // A file edited so it no longer parses (front-matter or id line removed) or
      // whose read-only `cls`, `confidence` or `reviewState` line was changed is
      // still the user's edit: keep it (the read-only lines have no proposal, so
      // the user reverts them by hand). With no manifest entry nobody is known to
      // have edited the file, so a stale read-only line there is just stale and
      // gets refreshed.
      const unreviewedEdit = parsed === null
        || diffProjectionToProposals([record], [parsed], options).length > 0
        || (lastHash !== undefined && (
          (parsed.cls !== undefined && parsed.cls !== record.cls)
          || (parsed.confidence !== undefined && parsed.confidence !== record.confidence)
          || (parsed.reviewState !== undefined && parsed.reviewState !== record.reviewState)));
      if (changedSinceSync && unreviewedEdit) {
        if (lastHash !== undefined) next[record.id] = lastHash;
        kept.push(record.id);
        continue;
      }
    }
    writeFileSync(path, markdown, 'utf-8');
    next[record.id] = contentHash(markdown);
    written.push(path);
  }
  const standingIds = new Set(standing.map((record) => record.id));
  const removed: string[] = [];
  const orphaned: string[] = [];
  for (const [id, lastHash] of Object.entries(previous)) {
    if (standingIds.has(id)) continue;
    const path = join(dir, recordFileName(id));
    if (!existsSync(path)) continue;
    if (contentHash(readFileSync(path, 'utf-8')) === lastHash) {
      unlinkSync(path);
      removed.push(id);
    } else {
      // Still tracked, so the next sync keeps it too until the user removes it.
      next[id] = lastHash;
      orphaned.push(id);
    }
  }
  writeFileSync(join(dir, MANIFEST_NAME), `${JSON.stringify({ version: 1, files: next }, null, 2)}\n`, 'utf-8');
  let committed = false;
  if (options.git) {
    // Ownership gate: the projection only ever commits to a repository whose
    // toplevel IS the projection directory. A directory nested inside some
    // other checkout (or in no repository at all) gets its own repository
    // initialized first, committing into an enclosing repository would
    // pollute a checkout the projection merely sits inside.
    const toplevel = options.git.resolveToplevel(dir);
    if (toplevel === null || !samePath(toplevel, dir)) {
      options.git.init(dir);
    }
    options.git.add(dir);
    const removal = removed.length > 0 ? `, ${removed.length} removed` : '';
    committed = options.git.commit(dir, `memory projection: ${written.length} record(s)${removal}`) !== false;
  }
  return {
    dir, written,
    ...(kept.length > 0 ? { kept } : {}),
    ...(removed.length > 0 ? { removed } : {}),
    ...(orphaned.length > 0 ? { orphaned } : {}),
    committed,
  };
}

/** Parse one projected markdown file. Returns null when it has no `id` front-matter key. */
export function parseProjectedMemoryFile(path: string, content: string): MemoryProjectionFile | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;
  const front: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    front[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const id = front.id;
  if (!id) return null;

  const body = (match[2] ?? '').trim();
  const bodyLines = body.split('\n');
  const headingIdx = bodyLines.findIndex((line) => line.startsWith('# '));
  const summary = headingIdx >= 0 ? bodyLines[headingIdx]!.slice(2).trim() : (bodyLines[0]?.trim() ?? '');
  const detailText = headingIdx >= 0 ? bodyLines.slice(headingIdx + 1).join('\n').trim() : bodyLines.slice(1).join('\n').trim();

  const tags = parseTags(front.tags ?? '');
  const parseTime = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  };

  return {
    id,
    path,
    ...(front.scope === 'session' || front.scope === 'project' || front.scope === 'team' ? { scope: front.scope } : {}),
    ...(front.cls ? { cls: front.cls as MemoryClass } : {}),
    ...(front.confidence && Number.isFinite(Number(front.confidence)) ? { confidence: Number(front.confidence) } : {}),
    ...(front.reviewState ? { reviewState: front.reviewState } : {}),
    summary,
    ...(detailText ? { detail: detailText } : {}),
    tags,
    ...(parseTime(front.validFrom) !== undefined ? { validFrom: parseTime(front.validFrom) } : {}),
    ...(parseTime(front.validUntil) !== undefined ? { validUntil: parseTime(front.validUntil) } : {}),
  };
}

/**
 * One entry in the LIVE memory projection (computed from the store's standing
 * records, not read from disk), the shape the memory.projections.* wire verbs
 * expose. `status` is the record's live temporal status (active / expired /
 * pending), so an expired record is visibly labelled rather than silently
 * dropped, exactly as the file projection labels it.
 */
export interface MemoryProjectionEntry {
  readonly id: string;
  /** The `<id>.md` filename the file projection would use, a stable per-record handle. */
  readonly filename: string;
  readonly scope: MemoryScope;
  readonly cls: MemoryClass;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly reviewState: string;
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
  readonly status: MemoryTemporalStatus;
}

function toProjectionEntry(record: MemoryRecord, now: number): MemoryProjectionEntry {
  return {
    id: record.id,
    filename: recordFileName(record.id),
    scope: record.scope,
    cls: record.cls,
    summary: record.summary,
    tags: record.tags,
    confidence: record.confidence,
    reviewState: record.reviewState,
    ...(record.validFrom !== undefined ? { validFrom: record.validFrom } : {}),
    ...(record.validUntil !== undefined ? { validUntil: record.validUntil } : {}),
    status: memoryRecordTemporalStatus(record, now),
  };
}

/**
 * The live projection of standing (project/team) memory records, one metadata
 * entry per record, oldest first. Does not touch disk. Session-scope records are
 * excluded (they are not standing memory), matching the file projection's own
 * scope selection.
 */
export function listMemoryProjections(
  records: readonly MemoryRecord[],
  options: MemoryProjectionOptions & { readonly now?: number } = {},
): MemoryProjectionEntry[] {
  const now = options.now ?? Date.now();
  return selectStandingRecords(records, options).map((record) => toProjectionEntry(record, now));
}

/**
 * The live projection of ONE standing record by id: its metadata entry plus the
 * exact markdown the file projection would write. Returns null when no standing
 * record has that id (a session-scope or unknown id is an honest miss, not an
 * empty projection).
 */
export function getMemoryProjection(
  records: readonly MemoryRecord[],
  id: string,
  options: MemoryProjectionOptions & { readonly now?: number } = {},
): { readonly entry: MemoryProjectionEntry; readonly markdown: string } | null {
  const now = options.now ?? Date.now();
  const record = selectStandingRecords(records, options).find((candidate) => candidate.id === id);
  if (!record) return null;
  return { entry: toProjectionEntry(record, now), markdown: projectMemoryRecordToMarkdown(record, now) };
}

/** The parsed files of a projection directory, carrying which ids the last sync projected. */
export type ProjectedMemoryFiles = MemoryProjectionFile[] & {
  /** From the directory's manifest; null when it has none. Read by `diffProjectionToProposals`. */
  readonly projectedIds?: ReadonlySet<string> | null;
};

/**
 * Read + parse every `*.md` in the projection directory. The result also
 * carries the ids the last sync projected (as a non-enumerable `projectedIds`),
 * so `diffProjectionToProposals(records, readProjectedMemoryFiles(dir))` can tell
 * a deleted file from a record the store gained since.
 */
export function readProjectedMemoryFiles(dir: string): ProjectedMemoryFiles {
  const files: MemoryProjectionFile[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const path = join(dir, name);
      const parsed = parseProjectedMemoryFile(path, readFileSync(path, 'utf-8'));
      if (parsed) files.push(parsed);
    }
  }
  return Object.defineProperty(files, 'projectedIds', { value: readProjectedMemoryIds(dir), enumerable: false });
}

export type MemoryProjectionProposalKind = 'update' | 'delete';

/**
 * A proposed change from the projection round-trip, a review-queue entry, NOT a
 * write. The caller confirms (or not) each entry; only confirmed entries mutate
 * the store, through the registry's own update/delete.
 */
export interface MemoryProjectionProposal {
  readonly kind: MemoryProjectionProposalKind;
  readonly id: string;
  /** Honest human-readable reason this change is proposed. */
  readonly reason: string;
  /** For 'update': the record fields the edited file would change. */
  readonly changedFields?: readonly string[] | undefined;
  /** The desired field values parsed from the file (for 'update'). */
  readonly desired?: {
    readonly scope?: MemoryScope | undefined;
    readonly summary?: string | undefined;
    readonly detail?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly validFrom?: number | null | undefined;
    readonly validUntil?: number | null | undefined;
  } | undefined;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((tag) => setB.has(tag));
}

/**
 * Diff the current record set against the projected files and produce proposals.
 * PURE, no I/O. An edited file whose fields differ from its record yields an
 * `update` proposal; an in-scope record with NO file yields a `delete` proposal
 * only when `projectedIds` (see `readProjectedMemoryIds`; the files read by
 * `readProjectedMemoryFiles` carry it) says it was projected, because a record
 * the store gained after the last sync has no file either and is not a
 * deletion; without `projectedIds` no delete is proposed. A file with
 * no matching record has nothing to propose (its record is already gone);
 * `findOrphanedProjectionFiles` lists those. Nothing here mutates the store.
 */
export function diffProjectionToProposals(
  records: readonly MemoryRecord[],
  files: readonly MemoryProjectionFile[],
  options: MemoryProjectionOptions & { readonly projectedIds?: ReadonlySet<string> | null | undefined } = {},
): MemoryProjectionProposal[] {
  const scopes = new Set(options.scopes ?? DEFAULT_PROJECTION_SCOPES);
  const filesById = new Map(files.map((file) => [file.id, file]));
  const projectedIds = options.projectedIds !== undefined ? options.projectedIds : (files as ProjectedMemoryFiles).projectedIds;
  const proposals: MemoryProjectionProposal[] = [];

  for (const record of records) {
    if (!scopes.has(record.scope)) continue;
    const file = filesById.get(record.id);
    if (!file) {
      if (!projectedIds?.has(record.id)) continue;
      proposals.push({
        kind: 'delete',
        id: record.id,
        reason: `Projected file for "${record.summary}" was removed; propose deleting the record (confirmation required).`,
      });
      continue;
    }

    const changedFields: string[] = [];
    const desired: {
      scope?: MemoryScope;
      summary?: string;
      detail?: string;
      tags?: string[];
      validFrom?: number | null;
      validUntil?: number | null;
    } = {};
    if (file.summary && normalizeSummary(file.summary) !== normalizeSummary(record.summary)) { changedFields.push('summary'); desired.summary = file.summary; }
    // The file holds the trimmed detail, so compare trimmed on both sides.
    // Line endings are not content: a CRLF detail must not read as edited after a sync.
    const fileDetail = (file.detail ?? '').replace(/\r\n/g, '\n').trim();
    if (fileDetail !== (record.detail ?? '').replace(/\r\n/g, '\n').trim()) { changedFields.push('detail'); desired.detail = fileDetail; }
    if (!sameTags(file.tags, record.tags)) { changedFields.push('tags'); desired.tags = [...file.tags]; }
    if (file.scope && file.scope !== record.scope) { changedFields.push('scope'); desired.scope = file.scope; }
    if ((file.validFrom ?? undefined) !== (record.validFrom ?? undefined)) {
      changedFields.push('validFrom');
      desired.validFrom = file.validFrom ?? null;
    }
    if ((file.validUntil ?? undefined) !== (record.validUntil ?? undefined)) {
      changedFields.push('validUntil');
      desired.validUntil = file.validUntil ?? null;
    }

    if (changedFields.length > 0) {
      proposals.push({
        kind: 'update',
        id: record.id,
        reason: `Projected file edited (${changedFields.join(', ')}); propose updating the record (confirmation required).`,
        changedFields,
        desired,
      });
    }
  }

  return proposals;
}

/**
 * Files in the projection whose record is no longer in the store, or no longer
 * in a projected scope. PURE, no I/O. Review lists them so the directory is
 * never reported as matching the store while it shows memories that do not
 * exist; an edit to such a file cannot reach the store.
 */
export function findOrphanedProjectionFiles(
  records: readonly MemoryRecord[],
  files: readonly MemoryProjectionFile[],
  options: MemoryProjectionOptions = {},
): MemoryProjectionFile[] {
  const standingIds = new Set(selectStandingRecords(records, options).map((record) => record.id));
  return files.filter((file) => !standingIds.has(file.id));
}

/** The registry surface the projection apply needs, update + delete only. */
export interface MemoryProjectionRegistry {
  update(id: string, patch: {
    scope?: MemoryScope;
    summary?: string;
    detail?: string;
    tags?: string[];
    validFrom?: number | null;
    validUntil?: number | null;
  }): MemoryRecord | null;
  delete(id: string): boolean;
}

export interface MemoryProjectionApplyReceipt {
  readonly applied: readonly MemoryProjectionProposal[];
  /** Proposals the caller did NOT confirm, left untouched (the gate). */
  readonly skipped: readonly MemoryProjectionProposal[];
  /** Proposals confirmed but whose store mutation returned no record / false. */
  readonly failed: readonly MemoryProjectionProposal[];
}

/**
 * Apply ONLY the proposals the caller confirms, through the registry's own
 * update/delete. This is the confirmation gate: a proposal is never applied
 * unless `confirm(proposal)` returns true, a file edit can never become a
 * silent store write. Unconfirmed proposals are recorded as skipped.
 */
export function applyMemoryProjectionProposals(
  registry: MemoryProjectionRegistry,
  proposals: readonly MemoryProjectionProposal[],
  options: { readonly confirm: (proposal: MemoryProjectionProposal) => boolean },
): MemoryProjectionApplyReceipt {
  const applied: MemoryProjectionProposal[] = [];
  const skipped: MemoryProjectionProposal[] = [];
  const failed: MemoryProjectionProposal[] = [];

  for (const proposal of proposals) {
    if (!options.confirm(proposal)) {
      skipped.push(proposal);
      continue;
    }
    if (proposal.kind === 'delete') {
      const ok = registry.delete(proposal.id);
      (ok ? applied : failed).push(proposal);
      continue;
    }
    const desired = proposal.desired ?? {};
    const patch: Parameters<MemoryProjectionRegistry['update']>[1] = {
      ...(desired.scope !== undefined ? { scope: desired.scope } : {}),
      ...(desired.summary !== undefined ? { summary: desired.summary } : {}),
      ...(desired.detail !== undefined ? { detail: desired.detail } : {}),
      ...(desired.tags !== undefined ? { tags: [...desired.tags] } : {}),
      ...(desired.validFrom !== undefined ? { validFrom: desired.validFrom } : {}),
      ...(desired.validUntil !== undefined ? { validUntil: desired.validUntil } : {}),
    };
    const result = registry.update(proposal.id, patch);
    (result ? applied : failed).push(proposal);
  }

  return { applied, skipped, failed };
}
