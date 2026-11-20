import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../../utils/atomic-json-store.js';
import { dirname, join, resolve, sep } from 'node:path';
import { VERSION } from '../../version.js';
import { logger } from '../../utils/logger.js';
import { publishReplacement, recoverReplacements, stageReplacement } from '../../state/commit-point.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation } from '../decision-policy.js';
import { rankClassicCatalog } from '../classic-catalog.js';
import { fanOut, toJson, type EntryType } from '@goodvibes-jev/judgment';
import { catalogSearch, catalogSearchAt, catalogSearchEntryView } from './batteries/catalog-search.js';
import { trustNoteCaution } from './batteries/trust-note-caution.js';

export type EcosystemEntryKind = 'plugin' | 'skill' | 'hook-pack' | 'policy-pack';
export interface EcosystemCatalogPathOptions {
  readonly cwd: string;
  readonly homeDir: string;
  readonly projectCatalogRoot?: string | undefined;
  readonly userCatalogRoot?: string | undefined;
  readonly projectInstallRoot?: string | undefined;
  readonly userInstallRoot?: string | undefined;
}

export interface EcosystemCatalogEntry {
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly name: string;
  readonly summary: string;
  readonly version?: string | undefined;
  readonly author?: string | undefined;
  readonly source: string;
  readonly tags: readonly string[];
  readonly trustNotes?: string | undefined;
  readonly installHint?: string | undefined;
  readonly provenance?: string | undefined;
  readonly signature?: string | undefined;
  readonly updateHint?: string | undefined;
  readonly runtimeFit?: {
    readonly minAppVersion?: string | undefined;
    readonly maxAppVersion?: string | undefined;
    readonly platforms?: readonly string[] | undefined;
    readonly requiresSandbox?: boolean | undefined;
  };
  readonly compatibility?: {
    readonly minAppVersion?: string | undefined;
    readonly maxAppVersion?: string | undefined;
    readonly platforms?: readonly string[] | undefined;
    readonly requiresSandbox?: boolean | undefined;
    readonly appVersion?: string | undefined;
    readonly status?: 'supported' | 'warning' | undefined;
    readonly reasons?: readonly string[] | undefined;
  };
}

export interface EcosystemCatalogFile {
  readonly version: 1;
  readonly entries: EcosystemCatalogEntry[];
}

export interface EcosystemInstallReceipt {
  readonly version: 1;
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly installedAt: number;
  readonly scope: 'project' | 'user';
  readonly entry: EcosystemCatalogEntry;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly provenanceSummary: string;
  readonly runtimeFit: {
    readonly appVersion: string;
    readonly status: 'supported' | 'warning';
    readonly reasons: readonly string[];
  };
  readonly compatibility: {
    readonly appVersion: string;
    readonly status: 'supported' | 'warning';
    readonly reasons: readonly string[];
  };
  /** Present when the entry was installed from a pinned capability bundle: what was verified and what was granted. */
  readonly bundle?: EcosystemBundleGrant | undefined;
}

/** The pin and the capability grant an installed bundle carries in its receipt; the loader reads the grant from here. */
export interface EcosystemBundleGrant {
  readonly source: { readonly kind: 'file' | 'url' | 'git'; readonly location: string; readonly sha256: string; readonly ref?: string | undefined };
  readonly trustTier: string;
  /** Security capabilities granted at the trust tier. */
  readonly granted: readonly string[];
  /** Declared capabilities the tier did not grant (withheld). */
  readonly withheld: readonly string[];
  readonly quarantined: boolean;
  /** Declared surfaces: tools registered, hooks subscribed, config domains read, channels touched. */
  readonly tools: readonly string[];
  readonly hooks: readonly string[];
  readonly configDomains: readonly string[];
  readonly channels: readonly string[];
}

export interface EcosystemCatalogBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly scope: 'project' | 'user';
  readonly entries: readonly EcosystemCatalogEntry[];
}

export interface EcosystemCatalogBundleSummary {
  readonly exportedAt: number;
  readonly scope: 'project' | 'user';
  readonly counts: Readonly<Record<EcosystemEntryKind, number>>;
}

export interface EcosystemInstallBackup {
  readonly version: 1;
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly createdAt: number;
  readonly scope: 'project' | 'user';
  readonly archivedTargetPath: string;
  readonly targetPath: string;
  readonly receipt: EcosystemInstallReceipt;
  readonly reason: 'update' | 'uninstall' | 'replace';
}

const ENTRY_KINDS: readonly EcosystemEntryKind[] = ['plugin', 'skill', 'hook-pack', 'policy-pack'];

/**
 * An entry id becomes a directory name under the install root and part of
 * receipt and backup file names, so it must be one plain path segment: it
 * starts with a letter or digit (which rules out `.` and `..`) and holds only
 * letters, digits, dot, underscore and hyphen.
 */
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeEcosystemEntryId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 128 && ENTRY_ID_PATTERN.test(id);
}

function unsafeIdMessage(kind: EcosystemEntryKind, id: string): string {
  return `Curated ${kind} entry id ${JSON.stringify(id)} is not allowed: ids start with a letter or digit and contain only letters, digits, '.', '_' and '-'.`;
}

/** True when `path` is strictly inside `root`; the root itself is not. */
function isInside(root: string, path: string): boolean {
  const base = resolve(root);
  return resolve(path).startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCatalogRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  if (scope === 'project') {
    return options.projectCatalogRoot ?? join(options.cwd, '.goodvibes', 'ecosystem');
  }
  return options.userCatalogRoot ?? join(options.homeDir, '.goodvibes', 'ecosystem');
}

function catalogPath(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(resolveCatalogRoot(options, scope), `${kind}s.json`);
}

function catalogPaths(kind: EcosystemEntryKind, options: EcosystemCatalogPathOptions): string[] {
  return [
    catalogPath(kind, options, 'project'),
    catalogPath(kind, options, 'user'),
  ];
}

function resolveInstallRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  if (scope === 'project') {
    return options.projectInstallRoot ?? join(options.cwd, '.goodvibes');
  }
  return options.userInstallRoot ?? join(options.homeDir, '.goodvibes');
}

function installedRoot(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  const base = resolveInstallRoot(options, scope);
  switch (kind) {
    case 'plugin':
      return join(base, 'plugins');
    case 'skill':
      return join(base, 'skills');
    case 'hook-pack':
      return join(base, 'hooks', 'packs');
    case 'policy-pack':
      return join(base, 'policies', 'packs');
  }
}

function installedReceiptsRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(resolveCatalogRoot(options, scope), 'installed');
}

function receiptPath(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  const base = installedReceiptsRoot(options, scope);
  return join(base, `${kind}-${entryId}.json`);
}

function backupRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(installedReceiptsRoot(options, scope), 'backups');
}

function backupPrefix(kind: EcosystemEntryKind, entryId: string): string {
  return `${kind}-${entryId}`;
}

function backupMetaPath(
  kind: EcosystemEntryKind,
  entryId: string,
  createdAt: number,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(backupRoot(options, scope), `${backupPrefix(kind, entryId)}-${createdAt}.json`);
}

function backupArchivePath(
  kind: EcosystemEntryKind,
  entryId: string,
  createdAt: number,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(backupRoot(options, scope), `${backupPrefix(kind, entryId)}-${createdAt}`);
}

function loadReceipt(path: string): EcosystemInstallReceipt | null {
  try {
    return readJsonFileOrQuarantine<EcosystemInstallReceipt>(path, {
      label: 'runtime/ecosystem-install-receipt',
      recovery: 'This entry reads as not installed: its installed files are untouched on disk, but reinstalling it is what re-establishes a receipt (and with it, rollback).',
      validate: (raw) => {
        const parsed = raw as EcosystemInstallReceipt | null;
        if (parsed?.version !== 1) throw new Error('install receipt is not a version 1 receipt');
        return parsed;
      },
    });
  } catch {
    return null;
  }
}

function loadBackup(path: string): EcosystemInstallBackup | null {
  try {
    return readJsonFileOrQuarantine<EcosystemInstallBackup>(path, {
      label: 'runtime/ecosystem-install-backup',
      recovery: 'This backup is not offered for rollback; the archived copy of the files it described is still on disk beside it and can be restored by hand.',
      validate: (raw) => {
        const parsed = raw as EcosystemInstallBackup | null;
        if (parsed?.version !== 1) throw new Error('install backup is not a version 1 backup');
        return parsed;
      },
    });
  } catch {
    return null;
  }
}

/** Backups kept per installed entry; the oldest beyond this are removed when a new one is taken. */
export const ECOSYSTEM_BACKUPS_KEPT = 5;

function createBackupFromReceipt(
  receipt: EcosystemInstallReceipt,
  reason: EcosystemInstallBackup['reason'],
  options: EcosystemCatalogPathOptions,
): EcosystemInstallBackup {
  const createdAt = Date.now();
  const archivedTargetPath = backupArchivePath(receipt.kind, receipt.entry.id, createdAt, options, receipt.scope);
  mkdirSync(dirname(archivedTargetPath), { recursive: true });
  rmSync(archivedTargetPath, { recursive: true, force: true });
  if (existsSync(receipt.targetPath)) {
    cpSync(receipt.targetPath, archivedTargetPath, { recursive: true });
  } else {
    mkdirSync(archivedTargetPath, { recursive: true });
  }
  const backup: EcosystemInstallBackup = {
    version: 1,
    id: `${receipt.kind}:${receipt.entry.id}:${createdAt}`,
    kind: receipt.kind,
    createdAt,
    scope: receipt.scope,
    archivedTargetPath,
    targetPath: receipt.targetPath,
    receipt,
    reason,
  };
  writeJsonFileAtomic(backupMetaPath(receipt.kind, receipt.entry.id, createdAt, options, receipt.scope), backup);
  pruneBackups(receipt.kind, receipt.entry.id, options, receipt.scope);
  return backup;
}

/**
 * Keep the newest {@link ECOSYSTEM_BACKUPS_KEPT} backups of one entry and
 * remove the rest (metadata and archived copy). One listing of the backup
 * directory; best effort, since a backup that cannot be removed now is removed
 * by the next one.
 */
function pruneBackups(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): void {
  const dir = backupRoot(options, scope);
  const prefix = `${backupPrefix(kind, entryId)}-`;
  let stamps: number[];
  try {
    stamps = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map((name) => Number(name.slice(prefix.length, -'.json'.length)))
      .filter((stamp) => Number.isSafeInteger(stamp))
      .sort((a, b) => b - a);
  } catch {
    return;
  }
  for (const stamp of stamps.slice(ECOSYSTEM_BACKUPS_KEPT)) {
    try {
      rmSync(backupArchivePath(kind, entryId, stamp, options, scope), { recursive: true, force: true });
      rmSync(backupMetaPath(kind, entryId, stamp, options, scope), { force: true });
    } catch {
      // Left for the next backup of this entry to remove.
    }
  }
}

/**
 * Replace `targetPath` with a copy of `sourcePath`: copy into a staging
 * directory beside the target first, then swap by rename, so a copy that fails
 * half way leaves the installed copy untouched. `commit` runs after the swap
 * (the receipt write); if it throws, the previous copy is put back. Install and
 * rollback both replace a directory through here.
 */
function replaceDirectory(
  sourcePath: string,
  targetPath: string,
  receiptFile: string,
  commit: () => void,
): { ok: true } | { ok: false; error: unknown; displacedPath?: string } {
  const root = dirname(targetPath);
  mkdirSync(root, { recursive: true });
  // A swap a crash interrupted earlier is settled first: the copy in place stays
  // only when its receipt was written after it was put there; otherwise the
  // copy that was replaced comes back, and the receipt on disk describes it.
  recoverReplacements(root, (path) => path !== targetPath || receiptWrittenAfter(receiptFile, path));
  const replacement = stageReplacement(targetPath, 'directory');
  let committed = false;
  try {
    cpSync(sourcePath, replacement.staged, { recursive: true });
    // The receipt is the commit: written after the new copy is in place and
    // before the replaced copy is removed. A receipt that fails puts the
    // replaced copy back (a first install leaves nothing behind).
    publishReplacement(replacement, () => { commit(); committed = true; });
    return { ok: true };
  } catch (error) {
    // Installed and recorded: only removing the replaced copy failed, which is not a failed install.
    if (committed) {
      logger.warn('ecosystem catalog: the replaced copy could not be removed after the install was recorded', { target: targetPath, error: errorText(error) });
      return { ok: true };
    }
    rmSync(replacement.staged, { recursive: true, force: true });
    if (replacement.previous !== null && existsSync(replacement.previous)) return { ok: false, error, displacedPath: replacement.previous };
    return { ok: false, error };
  }
}

/** Whether `receiptFile` was written after `installed` was renamed into place (a rename sets the directory's change time). */
function receiptWrittenAfter(receiptFile: string, installed: string): boolean {
  try { return statSync(receiptFile).mtimeMs >= statSync(installed).ctimeMs; } catch { return false; }
}

function parseVersionParts(value: string): number[] {
  return value
    .split('.')
    .map((part) => parseInt(part.replace(/[^0-9].*$/, ''), 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const l = left[index]! ?? 0;
    const r = right[index]! ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function readCatalogFile(path: string): EcosystemCatalogEntry[] {
  return readCatalogDocument(path).entries;
}

/**
 * Read a curated catalog document. The document is read-modify-written by
 * every upsert and removal, so an unparseable one is quarantined rather than
 * silently replaced by the next write.
 */
function readCatalogDocument(path: string): EcosystemCatalogFile {
  const empty: EcosystemCatalogFile = { version: 1, entries: [] };
  try {
    return (
      readJsonFileOrQuarantine<EcosystemCatalogFile>(path, {
        label: 'runtime/ecosystem-catalog',
        recovery: 'The curated catalog for this entry kind reads as empty; already-installed entries keep working, and the catalog is rebuilt by importing a bundle or adding entries again.',
        validate: (raw) => {
          const parsed = raw as EcosystemCatalogFile | null;
          if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
            throw new Error('catalog file is not a version 1 document with an entries array');
          }
          return {
            version: 1,
            entries: parsed.entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && entry.kind !== undefined),
          };
        },
      }) ?? empty
    );
  } catch {
    return empty;
  }
}

export function loadEcosystemCatalog(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
): EcosystemCatalogEntry[] {
  const seen = new Set<string>();
  const entries: EcosystemCatalogEntry[] = [];

  for (const path of catalogPaths(kind, options)) {
    for (const entry of readCatalogFile(path)) {
      if (entry.kind !== kind) continue;
      // An unsafe id stays in the file but is never offered, so it cannot be installed.
      if (!isSafeEcosystemEntryId(entry.id)) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Candidates read in the one request a search makes. */
const SEARCH_PAGE_SIZE = 24;
/** Searches remembered per process; the oldest is forgotten first. */
const SEARCH_CACHE_LIMIT = 64;

const SEARCH_SITE = 'runtime.ecosystem.catalog-search';
const TRUST_NOTE_SITE = 'runtime.ecosystem.trust-note-caution';

/** Listed entry ids and the unchecked count per (kind, query, catalog files' size and time): a repeated search costs no request. */
const searchCache = new Map<string, { readonly ids: readonly string[]; readonly unchecked: number }>();
const pageQuestions = new Map<number, ReturnType<typeof catalogSearchAt>>();

function pageQuestion(index: number): ReturnType<typeof catalogSearchAt> {
  let question = pageQuestions.get(index);
  if (!question) {
    question = index === 0 ? catalogSearch : catalogSearchAt(index);
    pageQuestions.set(index, question);
  }
  return question;
}

/** The revision of a kind's catalogs: each file's path, inode, size and modification time (a catalog write replaces the file). */
function catalogStamp(kind: EcosystemEntryKind, options: EcosystemCatalogPathOptions): string {
  return catalogPaths(kind, options).map((path) => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path}:-`;
    }
  }).join('|');
}

function describeForRanking(entry: EcosystemCatalogEntry): { readonly id: string; readonly description: string } {
  return { id: entry.id, description: JSON.stringify(catalogSearchEntryView(entry)) };
}

/** Which entries of the page the reading keeps (all but a strong no). Throws when the request fails. */
async function readSearchPage(
  query: string,
  page: readonly EcosystemCatalogEntry[],
  signal: AbortSignal | undefined,
): Promise<readonly boolean[]> {
  const parts: Record<string, ReturnType<typeof catalogSearchAt>> = {};
  page.forEach((_, index) => { parts[`entry${index}`] = pageQuestion(index); });
  const read = await fanOut(judgmentPort(SEARCH_SITE), toJson({ query, entries: page.map(catalogSearchEntryView) }) as EntryType, parts, {
    site: SEARCH_SITE, label: catalogSearch.name, ...(signal ? { signal } : {}),
  });
  const kept = page.map((_, index) => {
    const reading = read.readings[`entry${index}`]?.wanted;
    return !(reading?.verdict === 'no' && reading.outcome === 'act');
  });
  read.recordAction(`listed ${kept.filter(Boolean).length} hid ${kept.filter((keep) => !keep).length}`);
  return kept;
}

/** A catalog search's answer and how many entries it did not check. */
export interface EcosystemCatalogSearch {
  /** The entries that answer the query, best match first. */
  readonly entries: EcosystemCatalogEntry[];
  /**
   * Entries past the one page read that share no word with the query: they
   * were neither read nor listed. Zero when every entry was checked.
   */
  readonly unchecked: number;
}

/** The line a surface prints under a search that left entries unchecked, or undefined when none were. */
export function describeUncheckedCatalogEntries(search: Pick<EcosystemCatalogSearch, 'unchecked'>): string | undefined {
  if (search.unchecked <= 0) return undefined;
  return `${search.unchecked} more ${search.unchecked === 1 ? 'entry was' : 'entries were'} not checked; narrow the query or list the catalog with no query.`;
}

/**
 * Catalog entries of `kind` that answer `query`, best match first. A blank
 * query lists every entry, in name order, with no reading. Otherwise the
 * entries are ranked locally by the words they share with the query, and the
 * top {@link SEARCH_PAGE_SIZE} candidates (the ranked matches, then the rest
 * in name order, so an entry described in other words is still read) go to
 * `engine.ecosystem.catalog-search` in ONE request, whatever the catalog's
 * size. A candidate is dropped only when read as a strong no; a ranked match
 * beyond the page is listed unread, and the entries beyond the page that share
 * no word with the query are counted in `unchecked`, so the answer never looks
 * more complete than it is. When the request fails the policy decides (the
 * local ranking over every entry, or a report). The answer is remembered for the process
 * by (kind, query, catalog files' size and time), so repeating a search, or
 * searching an unchanged catalog again, makes no request.
 */
export async function searchEcosystemCatalog(
  kind: EcosystemEntryKind,
  query: string,
  options: EcosystemCatalogPathOptions,
  run: { readonly signal?: AbortSignal } = {},
): Promise<EcosystemCatalogSearch> {
  run.signal?.throwIfAborted();
  const trimmed = query.trim();
  const entries = loadEcosystemCatalog(kind, options);
  if (!trimmed || entries.length === 0) return { entries, unchecked: 0 };
  const ranked = rankClassicCatalog(entries, trimmed, describeForRanking).map((match) => match.entry);
  return decisionOrClassic<EcosystemCatalogSearch>(async () => {
    const key = `${kind}\0${trimmed.toLocaleLowerCase()}\0${catalogStamp(kind, options)}`;
    const remembered = searchCache.get(key);
    if (remembered) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      return { entries: remembered.ids.flatMap((id) => byId.get(id) ?? []), unchecked: remembered.unchecked };
    }
    const rankedIds = new Set(ranked.map((entry) => entry.id));
    const candidates = [...ranked, ...entries.filter((entry) => !rankedIds.has(entry.id))];
    const page = candidates.slice(0, SEARCH_PAGE_SIZE);
    const kept = await readSearchPage(trimmed, page, run.signal);
    const result = [...page.filter((_, index) => kept[index]), ...ranked.slice(SEARCH_PAGE_SIZE)];
    // Past the page only the word matches are listed; the rest went unread.
    const unchecked = Math.max(0, candidates.length - SEARCH_PAGE_SIZE) - Math.max(0, ranked.length - SEARCH_PAGE_SIZE);
    searchCache.delete(key);
    searchCache.set(key, { ids: result.map((entry) => entry.id), unchecked });
    while (searchCache.size > SEARCH_CACHE_LIMIT) searchCache.delete(searchCache.keys().next().value!);
    return { entries: result, unchecked };
  }, () => {
    run.signal?.throwIfAborted();
    // The local ranking compares the query with every entry: none is left unchecked.
    return { entries: ranked, unchecked: 0 };
  });
}

/** The path and fit part of a catalog review: code only, no reading. Install uses this. */
export interface EcosystemCatalogSourceReview {
  entry: EcosystemCatalogEntry;
  sourcePath: string;
  sourceExists: boolean;
  sourceKind: 'local-path' | 'remote' | 'unknown';
  recommendedScope: 'project' | 'user';
  runtimeFit: {
    status: 'supported' | 'warning';
    reasons: readonly string[];
  };
  compatibility: {
    status: 'supported' | 'warning';
    reasons: readonly string[];
  };
}

/** A full catalog review as the review surfaces show it: the source review plus the risk label. */
export interface EcosystemCatalogReview extends EcosystemCatalogSourceReview {
  riskLevel: 'low' | 'medium';
}

/** Where an entry's source resolves, what kind of source it is, and whether it fits this runtime. */
export function reviewEcosystemCatalogSource(
  entry: EcosystemCatalogEntry,
  options: EcosystemCatalogPathOptions,
): EcosystemCatalogSourceReview {
  const { cwd, homeDir } = options;
  const sourcePath = entry.source.startsWith('/') || entry.source.startsWith('.')
    ? resolve(cwd, entry.source)
    : resolve(homeDir, entry.source);
  const sourceExists = existsSync(sourcePath);
  const sourceKind = entry.source.startsWith('/') || entry.source.startsWith('.')
    ? 'local-path'
    : entry.source.includes('://') || entry.source.startsWith('git+') || entry.source.startsWith('repo:')
      ? 'remote'
      : 'unknown';
  const reasons: string[] = [];
  if (entry.runtimeFit?.minAppVersion && compareVersions(VERSION, entry.runtimeFit.minAppVersion) < 0) {
    reasons.push(`requires GoodVibes >= ${entry.runtimeFit.minAppVersion}`);
  }
  if (entry.runtimeFit?.maxAppVersion && compareVersions(VERSION, entry.runtimeFit.maxAppVersion) > 0) {
    reasons.push(`targets GoodVibes <= ${entry.runtimeFit.maxAppVersion}`);
  }
  if (entry.runtimeFit?.platforms && entry.runtimeFit.platforms.length > 0 && !entry.runtimeFit.platforms.includes(process.platform)) {
    reasons.push(`targets platforms: ${entry.runtimeFit.platforms.join(', ')}`);
  }
  if (entry.runtimeFit?.requiresSandbox) {
    reasons.push('requires sandbox-backed execution support');
  }

  const fit = {
    status: reasons.length > 0 ? 'warning' as const : 'supported' as const,
    reasons,
  };

  return {
    entry,
    sourcePath,
    sourceExists,
    sourceKind,
    recommendedScope: entry.kind === 'plugin' ? 'project' : 'user',
    runtimeFit: fit,
    compatibility: fit,
  };
}

/**
 * The review shown before an install. riskLevel is medium for a remote
 * source (code) or when `engine.ecosystem.trust-note-caution` reads the
 * entry's trust note as a strong yes. An entry with no trust note, or a
 * remote one (already medium), takes no reading.
 */
export async function reviewEcosystemCatalogEntry(
  entry: EcosystemCatalogEntry,
  options: EcosystemCatalogPathOptions,
  run: { readonly signal?: AbortSignal } = {},
): Promise<EcosystemCatalogReview> {
  const source = reviewEcosystemCatalogSource(entry, options);
  // Classic reads no trust note: the source and compatibility review stands on its own.
  if (isClassicOperation()) {
    return { ...source, riskLevel: source.sourceKind === 'remote' ? 'medium' : 'low' };
  }
  const trustNotes = entry.trustNotes?.trim();
  let cautioned = false;
  if (source.sourceKind !== 'remote' && trustNotes) {
    const caution = await trustNoteCaution.run(
      judgmentPort(TRUST_NOTE_SITE),
      { name: entry.name, kind: entry.kind, trustNotes },
      { site: TRUST_NOTE_SITE, ...(run.signal ? { signal: run.signal } : {}) },
    );
    const reading = caution.readings.cautions;
    cautioned = reading.verdict === 'yes' && reading.outcome === 'act';
    caution.recordAction(cautioned ? 'risk-medium' : 'risk-low');
  }
  return {
    ...source,
    riskLevel: source.sourceKind === 'remote' || cautioned ? 'medium' : 'low',
  };
}

export function installEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user'; skipBackup?: boolean },
): { ok: true; receipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  if (!isSafeEcosystemEntryId(entryId)) return { ok: false, error: unsafeIdMessage(kind, String(entryId)) };
  const entry = loadEcosystemCatalog(kind, options).find((candidate) => candidate.id === entryId);
  if (!entry) return { ok: false, error: `Unknown curated ${kind} entry: ${entryId}` };
  const review = reviewEcosystemCatalogSource(entry, options);
  if (review.sourceKind !== 'local-path') {
    return { ok: false, error: `Curated ${kind} entry ${entryId} is not a local path source and cannot be installed directly.` };
  }
  if (!review.sourceExists) {
    return { ok: false, error: `Curated ${kind} source path does not exist: ${review.sourcePath}` };
  }

  const root = installedRoot(kind, options, scope);
  const targetPath = join(root, entry.id);
  if (!isInside(root, targetPath)) return { ok: false, error: unsafeIdMessage(kind, entryId) };
  try {
    const previousReceipt = loadReceipt(receiptPath(kind, entry.id, options, scope));
    if (previousReceipt && !options.skipBackup) {
      createBackupFromReceipt(previousReceipt, 'replace', options);
    }
  } catch (error) {
    return { ok: false, error: `Backing up ${kind} ${entryId} before installing failed: ${errorText(error)}. Nothing was changed.` };
  }
  const receipt: EcosystemInstallReceipt = {
    version: 1,
    id: `${kind}:${entry.id}`,
    kind,
    installedAt: Date.now(),
    scope,
    entry,
    sourcePath: review.sourcePath,
    targetPath,
    provenanceSummary: entry.provenance ?? entry.source,
    runtimeFit: {
      appVersion: VERSION,
      status: review.runtimeFit.status,
      reasons: review.runtimeFit.reasons,
    },
    compatibility: {
      appVersion: VERSION,
      status: review.runtimeFit.status,
      reasons: review.runtimeFit.reasons,
    },
  };
  const replaced = replaceDirectory(review.sourcePath, targetPath, receiptPath(kind, entry.id, options, scope), () => writeJsonFileAtomic(receiptPath(kind, entry.id, options, scope), receipt));
  if (replaced.ok) return { ok: true, receipt };
  if (replaced.displacedPath) {
    // The displaced copy stays on disk beside the target; the message names it.
    return { ok: false, error: `Installing ${kind} ${entryId} failed (${errorText(replaced.error)}) and the previous copy could not be put back; it is at ${replaced.displacedPath}.` };
  }
  return { ok: false, error: `Installing ${kind} ${entryId} failed: ${errorText(replaced.error)}. The previous install, if any, was left in place.` };
}

/** What a verified capability bundle installs: its manifest facts, payload files and grant. */
export interface VerifiedBundleInstall {
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string | undefined;
  /** Payload files by relative path; the bundle reader has already refused any path that could escape. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly grant: EcosystemBundleGrant;
}

/**
 * Install a pinned bundle whose bytes were verified and unpacked: the payload
 * is written to a staging directory and swapped into the entry's install
 * directory exactly as a catalog install is (backup of the previous install,
 * staged copy, rename, receipt), and the receipt carries the pin and the grant.
 * Updates, rollback, history and uninstall work on it like any installed entry.
 */
export function installVerifiedBundle(
  bundle: VerifiedBundleInstall,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; receipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const scope = options.scope ?? (bundle.kind === 'plugin' ? 'project' : 'user');
  const { kind, id } = bundle;
  if (!isSafeEcosystemEntryId(id)) return { ok: false, error: unsafeIdMessage(kind, String(id)) };
  const root = installedRoot(kind, options, scope);
  const targetPath = join(root, id);
  if (!isInside(root, targetPath)) return { ok: false, error: unsafeIdMessage(kind, id) };
  const unpacked = join(installedReceiptsRoot(options, scope), `.bundle-${kind}-${id}-${process.pid}`);
  try {
    const previousReceipt = loadReceipt(receiptPath(kind, id, options, scope));
    if (previousReceipt) createBackupFromReceipt(previousReceipt, 'replace', options);
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    for (const [path, bytes] of bundle.files) {
      const target = join(unpacked, path);
      if (!isInside(unpacked, target)) throw new Error(`bundle member '${path}' would be written outside the install directory`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { mode: 0o644 });
    }
  } catch (error) {
    rmSync(unpacked, { recursive: true, force: true });
    return { ok: false, error: `Unpacking ${kind} bundle ${id} failed: ${errorText(error)}. Nothing was installed.` };
  }
  const entry: EcosystemCatalogEntry = {
    id, kind, name: bundle.name, summary: bundle.description, version: bundle.version,
    ...(bundle.author ? { author: bundle.author } : {}),
    source: bundle.grant.source.location, tags: [], provenance: `sha256:${bundle.grant.source.sha256}`,
  };
  const receipt: EcosystemInstallReceipt = {
    version: 1,
    id: `${kind}:${id}`,
    kind,
    installedAt: Date.now(),
    scope,
    entry,
    sourcePath: bundle.grant.source.location,
    targetPath,
    provenanceSummary: `${bundle.grant.source.kind}:${bundle.grant.source.location} (sha256:${bundle.grant.source.sha256})`,
    runtimeFit: { appVersion: VERSION, status: 'supported', reasons: [] },
    compatibility: { appVersion: VERSION, status: 'supported', reasons: [] },
    bundle: bundle.grant,
  };
  const replaced = replaceDirectory(unpacked, targetPath, receiptPath(kind, id, options, scope), () => writeJsonFileAtomic(receiptPath(kind, id, options, scope), receipt));
  rmSync(unpacked, { recursive: true, force: true });
  if (replaced.ok) return { ok: true, receipt };
  if (replaced.displacedPath) {
    return { ok: false, error: `Installing ${kind} bundle ${id} failed (${errorText(replaced.error)}) and the previous copy could not be put back; it is at ${replaced.displacedPath}.` };
  }
  return { ok: false, error: `Installing ${kind} bundle ${id} failed: ${errorText(replaced.error)}. The previous install, if any, was left in place.` };
}

export function inspectInstalledEcosystemEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; receipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const receipt = loadReceipt(receiptPath(kind, entryId, options, scope));
  if (!receipt) {
    return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  }
  return { ok: true, receipt };
}

export function uninstallEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; removedPath: string } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  if (!isSafeEcosystemEntryId(entryId)) return { ok: false, error: unsafeIdMessage(kind, String(entryId)) };
  const receipt = loadReceipt(receiptPath(kind, entryId, options, scope));
  if (!receipt) return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  const root = installedRoot(kind, options, scope);
  if (typeof receipt.targetPath !== 'string' || !isInside(root, receipt.targetPath)) {
    return { ok: false, error: `The ${kind} receipt for ${entryId} points outside ${root}; nothing was removed. Delete the receipt by hand if it is stale.` };
  }
  try {
    createBackupFromReceipt(receipt, 'uninstall', options);
    rmSync(receipt.targetPath, { recursive: true, force: true });
    rmSync(receiptPath(kind, entryId, options, scope), { force: true });
  } catch (error) {
    return { ok: false, error: `Uninstalling ${kind} ${entryId} failed: ${errorText(error)}` };
  }
  return { ok: true, removedPath: receipt.targetPath };
}

export function updateInstalledEcosystemEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; receipt: EcosystemInstallReceipt; previousReceipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  if (!isSafeEcosystemEntryId(entryId)) return { ok: false, error: unsafeIdMessage(kind, String(entryId)) };
  const previousReceipt = loadReceipt(receiptPath(kind, entryId, options, scope));
  if (!previousReceipt) {
    return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  }
  try {
    createBackupFromReceipt(previousReceipt, 'update', options);
  } catch (error) {
    return { ok: false, error: `Backing up ${kind} ${entryId} before the update failed: ${errorText(error)}` };
  }

  const installed = installEcosystemCatalogEntry(kind, entryId, { ...options, scope, skipBackup: true });
  if (!installed.ok) return installed;
  return { ok: true, receipt: installed.receipt, previousReceipt };
}

export function listEcosystemInstallBackups(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): EcosystemInstallBackup[] {
  const scope = options.scope ?? 'project';
  const dir = backupRoot(options, scope);
  if (!existsSync(dir)) return [];
  const prefix = `${backupPrefix(kind, entryId)}-`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => loadBackup(join(dir, name)))
    .filter((backup): backup is EcosystemInstallBackup => backup !== null && backup.kind === kind && backup.receipt.entry.id === entryId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function rollbackInstalledEcosystemEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user'; backupId?: string },
): { ok: true; receipt: EcosystemInstallReceipt; restoredFrom: EcosystemInstallBackup } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  if (!isSafeEcosystemEntryId(entryId)) return { ok: false, error: unsafeIdMessage(kind, String(entryId)) };
  const backups = listEcosystemInstallBackups(kind, entryId, { ...options, scope });
  const backup = options.backupId
    ? backups.find((candidate) => candidate.id === options.backupId)
    : backups[0];
  if (!backup) {
    return { ok: false, error: `No rollback backup found for ${kind} ${entryId} in ${scope} scope.` };
  }
  const root = installedRoot(kind, options, scope);
  if (typeof backup.targetPath !== 'string' || !isInside(root, backup.targetPath)
    || typeof backup.archivedTargetPath !== 'string' || !isInside(backupRoot(options, scope), backup.archivedTargetPath)) {
    return { ok: false, error: `The ${kind} backup for ${entryId} points outside ${root}; nothing was restored.` };
  }
  const restored = replaceDirectory(backup.archivedTargetPath, backup.targetPath, receiptPath(kind, entryId, options, scope),
    () => writeJsonFileAtomic(receiptPath(kind, entryId, options, scope), backup.receipt));
  if (!restored.ok) {
    const left = restored.displacedPath
      ? `the installed copy could not be put back and is at ${restored.displacedPath}`
      : 'the installed copy was left in place';
    return { ok: false, error: `Rolling back ${kind} ${entryId} failed: ${errorText(restored.error)}; ${left}. The archived copy is still at ${backup.archivedTargetPath}.` };
  }
  return { ok: true, receipt: backup.receipt, restoredFrom: backup };
}

export function listInstalledEcosystemEntries(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
): EcosystemInstallReceipt[] {
  const receipts = [
    installedReceiptsRoot(options, 'project'),
    installedReceiptsRoot(options, 'user'),
  ];
  const found: EcosystemInstallReceipt[] = [];
  for (const dir of receipts) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
      const receipt = loadReceipt(join(dir, name));
      if (receipt && receipt.kind === kind) found.push(receipt);
    }
  }
  return found.sort((a, b) => b.installedAt - a.installedAt);
}

export function exportEcosystemCatalogBundle(
  scope: 'project' | 'user',
  options: EcosystemCatalogPathOptions,
): EcosystemCatalogBundle {
  const paths = {
    plugin: catalogPath('plugin', options, scope),
    skill: catalogPath('skill', options, scope),
    'hook-pack': catalogPath('hook-pack', options, scope),
    'policy-pack': catalogPath('policy-pack', options, scope),
  } as const;
  return {
    version: 1,
    exportedAt: Date.now(),
    scope,
    entries: [
      ...readCatalogFile(paths.plugin).filter((entry) => entry.kind === 'plugin'),
      ...readCatalogFile(paths.skill).filter((entry) => entry.kind === 'skill'),
      ...readCatalogFile(paths['hook-pack']).filter((entry) => entry.kind === 'hook-pack'),
      ...readCatalogFile(paths['policy-pack']).filter((entry) => entry.kind === 'policy-pack'),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function inspectEcosystemCatalogBundle(bundle: EcosystemCatalogBundle): EcosystemCatalogBundleSummary {
  const counts: Record<EcosystemEntryKind, number> = { plugin: 0, skill: 0, 'hook-pack': 0, 'policy-pack': 0 };
  // A bundle read from disk is untrusted: tolerate a non-array `entries`.
  const entries: readonly EcosystemCatalogEntry[] = Array.isArray(bundle?.entries) ? bundle.entries : [];
  for (const entry of entries) {
    if (entry && ENTRY_KINDS.includes(entry.kind)) counts[entry.kind] += 1;
  }
  return {
    exportedAt: bundle?.exportedAt,
    scope: bundle?.scope,
    counts,
  };
}

function entryProblem(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return 'not an object';
  const candidate = entry as Partial<Record<keyof EcosystemCatalogEntry, unknown>>;
  if (!ENTRY_KINDS.includes(candidate.kind as EcosystemEntryKind)) return `unknown kind ${JSON.stringify(candidate.kind)}`;
  if (!isSafeEcosystemEntryId(candidate.id)) return `unsafe or missing id ${JSON.stringify(candidate.id)}`;
  if (typeof candidate.name !== 'string' || typeof candidate.source !== 'string') return 'missing name or source';
  return null;
}

/**
 * Merge a bundle into the curated catalogs by (kind, id): bundle entries
 * replace entries with the same id, every other existing entry is kept.
 * Entries that fail validation are skipped and listed in `rejected`; a bundle
 * with no entries array imports nothing and says why in `error`.
 */
export function importEcosystemCatalogBundle(
  bundle: EcosystemCatalogBundle,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): {
  imported: number;
  pathByKind: Partial<Record<EcosystemEntryKind, string>>;
  rejected: readonly { readonly id: string; readonly reason: string }[];
  error?: string;
} {
  const scope = options.scope ?? (bundle?.scope === 'user' ? 'user' : 'project');
  if (!Array.isArray(bundle?.entries)) {
    return { imported: 0, pathByKind: {}, rejected: [], error: 'The bundle has no entries array; nothing was imported.' };
  }
  const byKind: Record<EcosystemEntryKind, EcosystemCatalogEntry[]> = {
    plugin: [],
    skill: [],
    'hook-pack': [],
    'policy-pack': [],
  };
  const rejected: { id: string; reason: string }[] = [];
  for (const entry of bundle.entries as readonly unknown[]) {
    const problem = entryProblem(entry);
    if (problem) {
      const id = (entry as { id?: unknown } | null)?.id;
      rejected.push({ id: typeof id === 'string' ? id : '(no id)', reason: problem });
      continue;
    }
    const valid = entry as EcosystemCatalogEntry;
    byKind[valid.kind].push({ ...valid, tags: Array.isArray(valid.tags) ? valid.tags : [], summary: typeof valid.summary === 'string' ? valid.summary : '' });
  }
  const pathByKind: Partial<Record<EcosystemEntryKind, string>> = {};
  let imported = 0;
  for (const kind of ENTRY_KINDS) {
    if (byKind[kind].length === 0) continue;
    const path = catalogPath(kind, options, scope);
    const incoming = new Set(byKind[kind].map((entry) => entry.id));
    const kept = readCatalogDocument(path).entries.filter((entry) => entry.kind !== kind || !incoming.has(entry.id));
    const merged = [...kept, ...byKind[kind]].sort((a, b) => a.name.localeCompare(b.name));
    writeJsonFileAtomic(path, { version: 1, entries: merged });
    pathByKind[kind] = path;
    imported += byKind[kind].length;
  }
  return { imported, pathByKind, rejected };
}

export function upsertEcosystemCatalogEntry(
  entry: EcosystemCatalogEntry,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; path: string; entry: EcosystemCatalogEntry } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  if (!isSafeEcosystemEntryId(entry.id)) return { ok: false, error: unsafeIdMessage(entry.kind, String(entry.id)) };
  const path = catalogPath(entry.kind, options, scope);
  const document = readCatalogDocument(path);
  const nextEntries = document.entries.filter((candidate) => candidate.id !== entry.id || candidate.kind !== entry.kind);
  nextEntries.push(entry);
  nextEntries.sort((a, b) => a.name.localeCompare(b.name));
  writeJsonFileAtomic(path, { version: 1, entries: nextEntries });
  return { ok: true, path, entry };
}

export function removeEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; path: string } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const path = catalogPath(kind, options, scope);
  const document = readCatalogDocument(path);
  const nextEntries = document.entries.filter((candidate) => candidate.id !== entryId || candidate.kind !== kind);
  if (nextEntries.length === document.entries.length) {
    return { ok: false, error: `Curated ${kind} catalog entry not found: ${entryId}` };
  }
  writeJsonFileAtomic(path, { version: 1, entries: nextEntries });
  return { ok: true, path };
}
