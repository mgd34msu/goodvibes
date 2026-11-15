import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../../utils/atomic-json-store.js';
import { dirname, join, resolve, sep } from 'node:path';
import { VERSION } from '../../version.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation } from '../decision-policy.js';
import { rankClassicCatalog } from '../classic-catalog.js';
import { mapLimit } from '@goodvibes-jev/judgment';
import { catalogSearch, catalogSearchEntryView } from './batteries/catalog-search.js';
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
  return backup;
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

/** (query, entry) readings in flight at once. */
const SEARCH_CONCURRENCY = 8;

const SEARCH_SITE = 'runtime.ecosystem.catalog-search';
const TRUST_NOTE_SITE = 'runtime.ecosystem.trust-note-caution';

/**
 * Catalog entries of `kind` that answer `query`, in name order. A blank
 * query lists every entry with no reading. Otherwise each entry is read
 * against the query by `engine.ecosystem.catalog-search`, one request per
 * entry, and dropped only when read as a strong no: hiding a real match costs
 * the searcher more than one extra row.
 */
export async function searchEcosystemCatalog(
  kind: EcosystemEntryKind,
  query: string,
  options: EcosystemCatalogPathOptions,
  run: { readonly signal?: AbortSignal } = {},
): Promise<EcosystemCatalogEntry[]> {
  run.signal?.throwIfAborted();
  const trimmed = query.trim();
  const entries = loadEcosystemCatalog(kind, options);
  if (!trimmed || entries.length === 0) return entries;
  return decisionOrClassic(async () => {
    const port = judgmentPort(SEARCH_SITE);
    const context = { site: SEARCH_SITE, ...(run.signal ? { signal: run.signal } : {}) };
    const kept = await mapLimit(entries, SEARCH_CONCURRENCY, async (entry) => {
      const search = await catalogSearch.run(port, { query: trimmed, entry: catalogSearchEntryView(entry) }, context);
      const reading = search.readings.wanted;
      const dropped = reading.verdict === 'no' && reading.outcome === 'act';
      search.recordAction(dropped ? 'hidden' : 'listed');
      return !dropped;
    });
    return entries.filter((_, index) => kept[index]);
  }, () => {
    run.signal?.throwIfAborted();
    return rankClassicCatalog(entries, trimmed, entry => ({ id: entry.id,
      description: JSON.stringify(catalogSearchEntryView(entry)) })).map(match => match.entry);
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
  const stagingPath = join(root, `.${entry.id}.staging-${process.pid}`);
  const displacedPath = join(root, `.${entry.id}.replaced-${process.pid}`);
  let displaced = false;
  try {
    const previousReceipt = loadReceipt(receiptPath(kind, entry.id, options, scope));
    if (previousReceipt && !options.skipBackup) {
      createBackupFromReceipt(previousReceipt, 'replace', options);
    }
    mkdirSync(root, { recursive: true });
    // Copy first and swap after: a failed copy leaves the installed copy untouched.
    rmSync(stagingPath, { recursive: true, force: true });
    cpSync(review.sourcePath, stagingPath, { recursive: true });
    rmSync(displacedPath, { recursive: true, force: true });
    if (existsSync(targetPath)) {
      renameSync(targetPath, displacedPath);
      displaced = true;
    }
    renameSync(stagingPath, targetPath);

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
    writeJsonFileAtomic(receiptPath(kind, entry.id, options, scope), receipt);
    if (displaced) rmSync(displacedPath, { recursive: true, force: true });
    return { ok: true, receipt };
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    if (displaced) {
      try {
        rmSync(targetPath, { recursive: true, force: true });
        renameSync(displacedPath, targetPath);
      } catch {
        // The displaced copy stays on disk beside the target; the message names it.
        return { ok: false, error: `Installing ${kind} ${entryId} failed (${errorText(error)}) and the previous copy could not be put back; it is at ${displacedPath}.` };
      }
    }
    return { ok: false, error: `Installing ${kind} ${entryId} failed: ${errorText(error)}. The previous install, if any, was left in place.` };
  }
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
  try {
    mkdirSync(dirname(backup.targetPath), { recursive: true });
    rmSync(backup.targetPath, { recursive: true, force: true });
    cpSync(backup.archivedTargetPath, backup.targetPath, { recursive: true });
    writeJsonFileAtomic(receiptPath(kind, entryId, options, scope), backup.receipt);
  } catch (error) {
    return { ok: false, error: `Rolling back ${kind} ${entryId} failed: ${errorText(error)}. The archived copy is still at ${backup.archivedTargetPath}.` };
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
