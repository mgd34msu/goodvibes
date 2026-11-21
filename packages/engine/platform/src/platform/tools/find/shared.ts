import { assertCapturedInputPathContext, isCapturedInputEntry, isCapturedInputPath } from '../../contract/input-authority.js';
import { assertCapturedToolReadAccess, assertCapturedToolInvocationCurrent, hasCapturedToolInvocation } from '../shared/captured-input-tools.js';
import { projectFileList, type FileListWalk } from './file-list.js';
import { hostRipgrep } from './ripgrep.js';
import { resolve, relative, basename, dirname, join, sep } from 'node:path';
import { stat as statAsync } from 'node:fs/promises';
import { statSync, lstatSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { walkDir, DirectoryWalk, WALK_SKIP_DIRS, type WalkDirOptions } from '../../utils/walk-dir.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import { resolveAndValidatePath } from '../../utils/path-safety.js';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { accessRestrictedNote, partitionByReadAccess, type ReadAccessFilter } from '../shared/read-access.js';

export type FindSearchOptions = JudgmentReadingOptions & WalkDirOptions & {
  allowOutsideProject?: boolean;
  /** The owner's per-file read decision; modes that read file text drop a file it restricts. */
  readAccessFilter?: ReadAccessFilter | undefined;
};

export type OutputFormat =
  | 'count_only'
  | 'files_only'
  | 'locations'
  | 'matches'
  | 'context'
  | 'with_stats'
  | 'with_preview'
  | 'signatures'
  | 'full';
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'enum';

export interface QueryBase {
  id: string;
  mode: 'files' | 'content' | 'symbols' | 'references' | 'structural';
  path?: string | undefined;
}

export interface FilesQuery extends QueryBase {
  mode: 'files';
  patterns?: string[] | undefined;
  exclude?: string[] | undefined;
  min_size?: number | undefined;
  max_size?: number | undefined;
  modified_after?: string | undefined;
  modified_before?: string | undefined;
  respect_gitignore?: boolean | undefined;
  sort_by?: 'name' | 'size' | 'modified' | undefined;
  sort_order?: 'asc' | 'desc' | undefined;
  has_content?: string | undefined;
  is_empty?: boolean | undefined;
  follow_symlinks?: boolean | undefined;
  include_hidden?: boolean | undefined;
}

export interface ContentQuery extends QueryBase {
  mode: 'content';
  pattern?: string | undefined;
  pattern_base64?: string | undefined;
  glob?: string | undefined;
  case_sensitive?: boolean | undefined;
  whole_word?: boolean | undefined;
  multiline?: boolean | undefined;
  negate?: boolean | undefined;
  ranked?: boolean | undefined;
  preview_replace?: string | undefined;
  relationships?: boolean | undefined;
}

export interface SymbolsQuery extends QueryBase {
  mode: 'symbols';
  query?: string | undefined;
  kinds?: SymbolKind[] | undefined;
  exported_only?: boolean | undefined;
  include_private?: boolean | undefined;
  group_by?: 'file' | 'kind' | 'none' | undefined;
}

export interface ReferencesQuery extends QueryBase {
  mode: 'references';
  symbol: string;
  file: string;
  line: number;
  column: number;
}

export interface StructuralQuery extends QueryBase {
  mode: 'structural';
  pattern: string;
  lang?: 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'html' | undefined;
  glob?: string | undefined;
}

export type FindQuery = FilesQuery | ContentQuery | SymbolsQuery | ReferencesQuery | StructuralQuery;

export interface OutputOptions {
  /** Offset into the complete ordered result set. */
  offset?: number | undefined;
  format?: OutputFormat | undefined;
  context_before?: number | undefined;
  context_after?: number | undefined;
  expand_to?: 'line' | 'block' | 'function' | 'class' | undefined;
  max_results?: number | undefined;
  max_per_item?: number | undefined;
  max_total_matches?: number | undefined;
  max_tokens?: number | undefined;
  preview_lines?: number | undefined;
  max_line_length?: number | undefined;
  /**
   * Set by the tool, not the caller: this query's share of the call's output
   * ceiling in characters, so the serialized call always fits in one result.
   */
  page_chars?: number | undefined;
}

export interface FindInput {
  queries: FindQuery[];
  output?: OutputOptions | undefined;
  parallel?: boolean | undefined;
  /** Per-call deadline; defaults to DEFAULT_FIND_TIMEOUT_MS. */
  timeout_ms?: number | undefined;
}

type CountResult = { count: number; file_count?: number; source?: string };
type FilesResult = { files: string[]; count: number; source?: string };
type LocationsResult<TLocation> = { locations: TLocation[]; count: number; source?: string };

interface CacheKey {
  pattern: string;
  glob: string;
  path: string;
  flags: string;
}

interface CacheValue {
  files: string[];
  matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>;
  totalMatches: number;
  fileMtimes: Map<string, number>;
}

export interface FindDiagnostics {
  warnings: string[];
}

export interface ContentMatch {
  file: string;
  line: number;
  text: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  context_before?: string[] | undefined;
  context_after?: string[] | undefined;
}

const MAX_FIND_WARNINGS = 20;

export function createFindDiagnostics(): FindDiagnostics {
  return { warnings: [] };
}

export function addFindWarning(diagnostics: FindDiagnostics | undefined, warning: string): void {
  if (!diagnostics) return;
  if (diagnostics.warnings.includes(warning)) return;
  if (diagnostics.warnings.length < MAX_FIND_WARNINGS) {
    diagnostics.warnings.push(warning);
    return;
  }
  const cappedWarning = `Additional find warnings suppressed after ${MAX_FIND_WARNINGS} entries.`;
  if (!diagnostics.warnings.includes(cappedWarning)) diagnostics.warnings.push(cappedWarning);
}

/** The warning a per-file scan adds when the time budget ends it before every file was searched. */
export function addBudgetStopWarning(diagnostics: FindDiagnostics | undefined, searched: number, total: number, found: number, unit: string): void {
  addFindWarning(diagnostics, `Stopped at the time budget: searched ${searched} of ${total} files and found ${found} ${unit} so far. `
    + "Narrow 'path' or 'glob', or pass a larger timeout_ms, to search the rest.");
}

/** The warning a scan adds when the time budget ended the search for files before the walk finished. */
export function addDiscoveryCutWarning(diagnostics: FindDiagnostics | undefined, found: number): void {
  addFindWarning(diagnostics, `Stopped at the time budget while finding files: ${found} file(s) were found before it ended, so more exist that were not searched. `
    + "Narrow 'path' or 'glob', or pass a larger timeout_ms, to search the rest.");
}

export function withFindWarnings<T extends Record<string, unknown>>(result: T, warnings: readonly string[]): T {
  if (warnings.length === 0) return result;
  const existingWarnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  return {
    ...result,
    warnings: [...existingWarnings, ...warnings],
  } as T;
}

export function makeCountResult(count: number, source?: string, fileCount?: number): CountResult {
  return fileCount !== undefined
    ? { count, file_count: fileCount, ...(source ? { source } : {}) }
    : { count, ...(source ? { source } : {}) };
}

export function makeFilesResult(files: string[], count: number, source?: string): FilesResult {
  return { files, count, ...(source ? { source } : {}) };
}

export function makeLocationsResult<TLocation>(
  locations: TLocation[],
  count: number,
  source?: string,
): LocationsResult<TLocation> {
  return { locations, count, ...(source ? { source } : {}) };
}

export const VALID_SYMBOL_KINDS = new Set(['function', 'class', 'interface', 'type', 'variable', 'constant', 'enum']);
const BINARY_CHECK_BYTES = 8192;

/** A text search does not open a file larger than this; the result counts the files skipped. */
export const SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** What one search over many files skipped without reading, reported once per query. */
export interface SearchSkips {
  /** Files over {@link SEARCH_MAX_FILE_BYTES}. */
  large: number;
  /** Files with a NUL byte in their first 8 KB. */
  binary: number;
}

export function createSearchSkips(): SearchSkips {
  return { large: 0, binary: 0 };
}

/** One warning for the files a search skipped by size; binary files are not text and are not reported. */
export function addSearchSkipWarnings(diagnostics: FindDiagnostics, skips: SearchSkips): void {
  if (skips.large > 0) {
    addFindWarning(diagnostics, `Skipped ${skips.large} file(s) larger than ${SEARCH_MAX_FILE_BYTES / (1024 * 1024)} MiB; they were not searched. `
      + 'Search one with exec (for example rg), or read a range of it with the read tool.');
  }
}

export interface SearchFile {
  readonly text: string;
  readonly mtimeMs: number;
}

const searchTextDecoder = new TextDecoder();

/** Whether bytes already read are binary: a NUL byte in the first 8 KB. */
export function hasBinaryPrefix(bytes: Uint8Array): boolean {
  const probe = Math.min(bytes.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < probe; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** The size and modification time of a file, or null when it cannot be read. */
export async function statSearchFile(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await statAsync(filePath);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * A file's text for a search, read once: one stat for the size bound and the
 * modification time, then one read, and the binary verdict from the first 8 KB
 * of the bytes already in hand. Null for a binary, oversized or unreadable file
 * (an unreadable one adds a warning). `known` is a stat the caller already made.
 */
export async function readSearchFile(
  filePath: string,
  diagnostics: FindDiagnostics | undefined,
  skips: SearchSkips,
  known?: { size: number; mtimeMs: number } | null,
): Promise<SearchFile | null> {
  try {
    await assertCapturedToolReadAccess(filePath);
    const info = known !== undefined ? known : await statSearchFile(filePath);
    if (!info) throw new Error('not a readable file');
    if (info.size > SEARCH_MAX_FILE_BYTES) { skips.large++; return null; }
    const bytes = await Bun.file(filePath).bytes();
    if (hasBinaryPrefix(bytes)) { skips.binary++; return null; }
    return { text: searchTextDecoder.decode(bytes), mtimeMs: info.mtimeMs };
  } catch (err) {
    addFindWarning(diagnostics, `Skipped unreadable file '${filePath}': ${summarizeError(err)}`);
    return null;
  }
}

/** Tells the model a directory was left out and how to ask for it, instead of letting it look absent. */
function reportSkippedWorktrees(diagnostics: FindDiagnostics | undefined, basePath: string): (path: string, entryCount: number | undefined) => void {
  return (path, entryCount) => {
    const shown = relative(basePath, path) || path;
    const size = entryCount === undefined ? 'contents not counted' : `${entryCount} entries not searched`;
    addFindWarning(diagnostics, `Skipped ${shown} (product worktrees, ${size}); pass path: '${shown}' to include it.`);
  };
}

/**
 * Every file under `dirPath` the walk selects, without opening any: whether a
 * file is text is decided when it is read ({@link readSearchFile}).
 */
async function collectWalkFiles(dirPath: string, diagnostics?: FindDiagnostics, walkOptions: WalkDirOptions = {}): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of walkDir(dirPath, {
    onSkippedProductWorktrees: reportSkippedWorktrees(diagnostics, dirPath),
    ...walkOptions, selectDirectory: directory => searchDirectorySelection(directory, walkOptions, diagnostics), beforeAttempt: () => {
      assertCapturedToolInvocationCurrent();
      walkOptions.beforeAttempt?.();
    }, beforeAsyncAttempt: async () => {
      assertCapturedToolInvocationCurrent();
      await walkOptions.beforeAsyncAttempt?.();
    }, assertPath: assertCapturedInputPathContext,
    site: 'tools.find.skip-directory',
  })) {
    files.push(filePath);
  }
  return files;
}

export async function readTextFile(filePath: string, diagnostics?: FindDiagnostics): Promise<string | null> {
  try {
    await assertCapturedToolReadAccess(filePath);
    return await Bun.file(filePath).text();
  } catch (err) {
    addFindWarning(diagnostics, `Skipped unreadable file '${filePath}': ${summarizeError(err)}`);
    return null;
  }
}

export async function collectGlobFiles(
  basePath: string,
  patterns: string[],
  includeHidden: boolean,
  followSymlinks: boolean,
  diagnostics?: FindDiagnostics,
  walk = new DirectoryWalk(basePath),
  walkOptions: WalkDirOptions = {},
): Promise<Set<string>> {
  const matchedFiles = new Set<string>();
  const visitedRealPaths = new Set<string>();
  const globs = compileGlobs(patterns, diagnostics);
  if (!globs.length) return matchedFiles;

  const reaches = globReach(basePath, patterns);
  const explicitDirectories = patterns.flatMap(pattern => pattern.split('/').flatMap((part, index, parts) =>
    WALK_SKIP_DIRS.has(part) ? [new Bun.Glob(parts.slice(0, index + 1).join('/'))] : []));
  const selectedFile = (file: string): boolean => globs.some(glob => matchesGlob(glob, file, basePath))
    && walkOptions.selectFile?.(file) !== false;
  const selectedDirectory = (directory: string): boolean | undefined => {
    const selection = searchDirectorySelection(directory, walkOptions, diagnostics);
    if (selection === false || !reaches(directory)) return false;
    // A wildcard's "possibly relevant" must not accidentally opt all generated
    // and dependency directories into discovery. Explicitly named ones work.
    if (selection === true || explicitDirectories.some(glob => matchesGlob(glob, directory, basePath))) return true;
    return undefined;
  };

  // Scan once for all explicit patterns. Directory meaning is settled before
  // descent, rather than filtering after Bun.Glob has already traversed it.
  for await (const file of walk.files({
    onSkippedProductWorktrees: reportSkippedWorktrees(diagnostics, basePath),
    ...walkOptions, includeHidden, followSymlinks, maxFileSize: Number.POSITIVE_INFINITY,
    selectFile: selectedFile, selectDirectory: selectedDirectory,
    beforeAttempt: () => {
      assertCapturedToolInvocationCurrent();
      walkOptions.beforeAttempt?.();
    },
    beforeAsyncAttempt: async () => {
      assertCapturedToolInvocationCurrent();
      await walkOptions.beforeAsyncAttempt?.();
    },
    assertPath: assertCapturedInputPathContext, site: 'tools.find.glob.skip-directory',
  })) {
    if (!selectedFile(file)) continue;
    if (followSymlinks) {
      try {
        const real = realpathSync(file);
        if (visitedRealPaths.has(real)) continue;
        visitedRealPaths.add(real);
      } catch (err) {
        addFindWarning(diagnostics, `Skipped '${file}' because symlink resolution failed: ${summarizeError(err)}`);
        continue;
      }
    }
    matchedFiles.add(file);
  }
  return matchedFiles;
}

function compileGlobs(patterns: readonly string[], diagnostics: FindDiagnostics | undefined): Array<InstanceType<typeof Bun.Glob>> {
  const globs: Array<InstanceType<typeof Bun.Glob>> = [];
  for (const pattern of patterns) {
    try {
      globs.push(new Bun.Glob(pattern));
    } catch (err) {
      addFindWarning(diagnostics, `Skipped invalid glob pattern '${pattern}': ${summarizeError(err)}`);
    }
  }
  return globs;
}

/**
 * Whether a directory can hold a match of `patterns`: each pattern's literal
 * prefix proves which subtrees cannot. Complex syntax stays conservative;
 * Bun.Glob remains the authority on individual file matches. A directory
 * passes only when its ancestors under `basePath` pass too.
 */
function globReach(basePath: string, patterns: readonly string[]): (directory: string) => boolean {
  const root = resolve(basePath);
  const prefixes = patterns.map(pattern => {
    const parts = pattern.split('/');
    if (pattern.startsWith('/') || parts.some(part => part === '.' || part === '..')) return root;
    const end = parts.findIndex(part => !/^[A-Za-z0-9_. -]+$/.test(part));
    return resolve(basePath, ...parts.slice(0, end < 0 ? parts.length : end));
  });
  return (directory) => prefixes.some(prefix => prefix === root || prefix === directory
    || prefix.startsWith(`${directory}${sep}`) || directory.startsWith(`${prefix}${sep}`));
}

export function matchesGlob(glob: InstanceType<typeof Bun.Glob>, filePath: string, basePath: string): boolean {
  const rel = relative(basePath, filePath);
  return glob.match(rel) || glob.match(filePath);
}

export function toSymbolKind(kind: string | undefined): SymbolKind {
  const kindMap: Record<string, SymbolKind> = {
    method: 'function',
    property: 'variable',
    namespace: 'variable',
  };
  const mappedKind = (kindMap[kind ?? ''] ?? kind ?? 'variable') as SymbolKind;
  return VALID_SYMBOL_KINDS.has(mappedKind) ? mappedKind : 'variable';
}

export function matchesSymbolQuery(name: string, queryRegex: RegExp | null): boolean {
  return queryRegex ? queryRegex.test(name) : true;
}

export async function loadFileLines(filePath: string): Promise<string[]> {
  const raw = await readTextFile(filePath);
  return raw === null ? [] : raw.split('\n');
}

export function groupByKey<T extends { file: string; kind: string }>(
  items: T[],
  groupBy: 'file' | 'kind' | 'none',
): Record<string, T[]> | null {
  if (groupBy === 'none') return null;
  const grouped: Record<string, T[]> = {};
  for (const item of items) {
    const key = groupBy === 'file' ? item.file : item.kind;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  }
  return grouped;
}

export function validateSearchPath(path: string | undefined, projectRoot: string, allowOutsideProject = false): string | { error: string } {
  try {
    return resolveAndValidatePath(path ?? '.', projectRoot, allowOutsideProject);
  } catch (error) {
    return { error: summarizeError(error) };
  }
}

export function buildGitignoreMatcher(
  gitignorePath: string,
  diagnostics?: FindDiagnostics,
): ((rel: string) => boolean) | null {
  return buildIgnoreFileMatcher([gitignorePath], diagnostics);
}

/** A directory's ignore files, in the order rg and fd apply them: `.ignore` after `.gitignore`, so its `!` lines win. */
export function directoryIgnoreFiles(directory: string): readonly string[] {
  return [resolve(directory, '.gitignore'), resolve(directory, '.ignore')];
}

/**
 * One matcher from several ignore files of one directory, read in order: a
 * later file's `!` line re-includes what an earlier one excluded. A file that
 * is absent is skipped; one that cannot be read is skipped with a warning.
 */
export function buildIgnoreFileMatcher(
  paths: readonly string[],
  diagnostics?: FindDiagnostics,
): ((rel: string) => boolean) | null {
  const sources: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      assertCapturedInputPathContext(path);
      sources.push(readFileSync(path, 'utf8'));
    } catch (err) {
      addFindWarning(diagnostics, `Could not read ignore file '${path}': ${summarizeError(err)}`);
    }
  }
  if (sources.length === 0) return null;
  const raw = sources.join('\n');

  interface GitignoreRule {
    negate: boolean;
    directoryOnly: boolean;
    glob: InstanceType<typeof Bun.Glob>;
  }
  const rules: GitignoreRule[] = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let negate = false;
    let pat = line;
    if (pat.startsWith('!')) {
      negate = true;
      pat = pat.slice(1);
    }
    const directoryOnly = pat.endsWith('/');
    if (directoryOnly) pat = pat.slice(0, -1);
    if (pat.startsWith('/')) pat = pat.slice(1);
    else if (!pat.includes('/')) pat = `**/${pat}`;

    try {
      rules.push({ negate, directoryOnly, glob: new Bun.Glob(pat) });
    } catch (err) {
      addFindWarning(diagnostics, `Skipped malformed .gitignore pattern '${line}': ${summarizeError(err)}`);
    }
  }

  if (rules.length === 0) return null;

  return (rel: string): boolean => {
    // An excluded parent directory excludes its descendants too. A file
    // negation cannot reinclude a child until its parent is included again.
    const segments = rel.split('/');
    for (let length = 1; length <= segments.length; length++) {
      const directory = length < segments.length;
      const candidate = segments.slice(0, length).join('/');
      let ignored = false;
      for (const rule of rules) {
        if ((!rule.directoryOnly || directory) && rule.glob.match(candidate)) {
          ignored = !rule.negate;
        }
      }
      if (ignored) return true;
    }
    return false;
  };
}

/**
 * Ignore rules applied where they live: the `.gitignore` and `.ignore` of each directory
 * between `root` and a path is read the first time a path below that directory
 * is asked about, and kept for the life of the matcher. No pre-walk and no cap:
 * asking about one file costs one read attempt per ancestor directory; asking
 * about every file of a tree reads each directory's file once. A matcher sees
 * the ignore files as they were when it first read them, so a long-lived caller
 * makes a new one per build.
 */
export function createNestedIgnoreMatcher(root: string, diagnostics?: FindDiagnostics): (absPath: string) => boolean {
  const byDirectory = new Map<string, ((rel: string) => boolean) | null>();
  const matcherFor = (directory: string): ((rel: string) => boolean) | null => {
    if (!byDirectory.has(directory)) byDirectory.set(directory, buildIgnoreFileMatcher(directoryIgnoreFiles(directory), diagnostics));
    return byDirectory.get(directory) ?? null;
  };
  return (absPath: string): boolean => {
    const rel = relative(root, absPath);
    if (!rel || rel.startsWith('..')) return false;
    const segments = rel.split(sep);
    // A directory's rules see paths relative to it; an ignored ancestor ignores everything below it.
    let directory = root;
    for (let depth = 0; depth < segments.length; depth++) {
      const matcher = matcherFor(directory);
      if (matcher?.(segments.slice(depth).join('/'))) return true;
      directory = resolve(directory, segments[depth]!);
    }
    return false;
  };
}

/** Discovery may encounter old contract views below a live workspace. Their
 * denial must prune that subtree, not prevent searching the ordinary project.
 * Explicit roots and every opened path still require the original authority. */
function searchDirectorySelection(directory: string, options: WalkDirOptions, diagnostics?: FindDiagnostics): boolean | undefined {
  const selection = options.selectDirectory?.(directory);
  if (selection === false) return false;
  try { assertCapturedInputPathContext(directory); }
  catch {
    addFindWarning(diagnostics, `Skipped protected captured input directory '${directory}'.`);
    return false;
  }
  return selection;
}

/** The names of the ignore files files mode reads at the root and reports when nested. */
export function isIgnoreFileName(name: string): boolean {
  return name === '.gitignore' || name === '.ignore';
}

/** Nested ignore files found by the walk files mode stops at; it stops after this many. */
export const NESTED_IGNORE_FILES_SHOWN = 5;

/**
 * The ignore files (`.gitignore`, `.ignore`) below `basePath` other than
 * `rootIgnoreFiles`, by a walk through hidden directories too, stopping at
 * {@link NESTED_IGNORE_FILES_SHOWN}. Files mode uses it only when the listing
 * cannot come from the held project file list, which records them as it lists.
 */
export async function findNestedIgnoreFiles(
  basePath: string, rootIgnoreFiles: readonly string[], walk = new DirectoryWalk(basePath), walkOptions: WalkDirOptions = {},
  diagnostics?: FindDiagnostics,
): Promise<string[]> {
  const nested: string[] = [];
  const nestedFile = (file: string): boolean => isIgnoreFileName(basename(file)) && !rootIgnoreFiles.includes(file);
  for await (const file of walk.files({
    ...walkOptions, includeHidden: true, maxFileSize: Number.POSITIVE_INFINITY,
    selectDirectory: directory => searchDirectorySelection(directory, walkOptions, diagnostics),
    selectFile: file => nestedFile(file) && walkOptions.selectFile?.(file) !== false,
    beforeAttempt: () => {
      assertCapturedToolInvocationCurrent();
      walkOptions.beforeAttempt?.();
    },
    beforeAsyncAttempt: async () => {
      assertCapturedToolInvocationCurrent();
      await walkOptions.beforeAsyncAttempt?.();
    },
    assertPath: assertCapturedInputPathContext, site: 'tools.find.gitignore.skip-directory',
  })) {
    if (nestedFile(file)) {
      nested.push(file);
      if (nested.length >= NESTED_IGNORE_FILES_SHOWN) break;
    }
  }
  return nested;
}

/**
 * The files a text search considers: the walk's files, or the glob's. None is
 * opened here. A plain search walk (no hidden files, no followed links, no
 * caller directory selection, outside a contract's captured input) is served
 * from the project's held file list (file-list.ts), which a repeated search
 * checks by directory stamps instead of walking; a glob or a file selection
 * filters that list as the walk would have.
 */
export async function collectFilesForSearch(
  basePath: string,
  queryGlob: string | undefined,
  diagnostics?: FindDiagnostics,
  walkOptions: WalkDirOptions = {},
): Promise<string[]> {
  const held = await heldSearchFiles(basePath, queryGlob === undefined ? undefined : [queryGlob], diagnostics, walkOptions);
  if (held) return held.files;
  if (!queryGlob) {
    return collectWalkFiles(basePath, diagnostics, walkOptions);
  }
  return Array.from(await collectGlobFiles(basePath, [queryGlob], false, false, diagnostics, new DirectoryWalk(basePath), walkOptions));
}

/** `.`: the first character of a hidden entry's name. */
const DOT = 46;

export interface HeldSearchFiles {
  /** The files the walk would have selected, filtered by the globs. */
  readonly files: string[];
  /** The ignore files (`.gitignore`, `.ignore`) of every listed directory, `basePath`'s own included. */
  readonly ignoreFiles: readonly string[];
}

/**
 * A search's files from the held project list (file-list.ts), or null when
 * this search must walk for itself: hidden entries, followed links, a size
 * limit, a caller directory selection, a glob naming a conventionally skipped
 * directory, or a contract's captured input. With `patterns`, a file is kept
 * when one of them matches it and the walk would have reached its directory,
 * exactly as {@link collectGlobFiles} selects; an invalid pattern is warned
 * about and matches nothing.
 */
export async function heldSearchFiles(
  basePath: string,
  patterns: readonly string[] | undefined,
  diagnostics: FindDiagnostics | undefined,
  walkOptions: WalkDirOptions,
): Promise<HeldSearchFiles | null> {
  const { selectFile, selectDirectory, includeHidden, followSymlinks, maxFileSize, onSkippedProductWorktrees, ...callOptions } = walkOptions;
  if (selectDirectory || includeHidden || followSymlinks || maxFileSize !== undefined || onSkippedProductWorktrees) return null;
  if (hasCapturedToolInvocation() || isCapturedInputPath(basePath)) return null;
  // A glob naming a conventionally skipped directory opts it in: that walk differs from the held one.
  if (patterns?.some((pattern) => pattern.split('/').some((part) => WALK_SKIP_DIRS.has(part)))) return null;
  let matchesPatterns: ((file: string) => boolean) | undefined;
  if (patterns !== undefined) {
    const globs = compileGlobs(patterns, diagnostics);
    const reaches = globReach(basePath, patterns);
    matchesPatterns = (file) => globs.some((glob) => matchesGlob(glob, file, basePath)) && reaches(dirname(file));
  }
  const walk: FileListWalk = (start, hooks) => {
    // The real path of each directory of this walk that is not captured input,
    // so an entry it lists is checked by name instead of being resolved: a
    // listed file or directory (not a link; links are not followed) has its
    // directory's real path joined with its name. A directory with no checked
    // parent (the start) is resolved in full.
    const clearDirectories = new Map<string, string>();
    const capturedEntry = (path: string, directory: boolean): boolean => {
      const parentReal = clearDirectories.get(dirname(path));
      if (parentReal === undefined) {
        if (isCapturedInputPath(path)) return true;
        try { clearDirectories.set(path, realpathSync(path)); } catch { /* resolved in full again */ }
        return false;
      }
      const name = basename(path);
      if (isCapturedInputEntry(parentReal, name)) return true;
      if (directory) clearDirectories.set(path, join(parentReal, name));
      return false;
    };
    return walkDir(start, {
      ...callOptions,
      // Hidden entries are listed only so the list can note the ignore files
      // among them; no hidden file is kept and no hidden directory entered.
      includeHidden: true,
      selectFile: (file) => {
        if (file.charCodeAt(file.lastIndexOf(sep) + 1) !== DOT) return true;
        if (isIgnoreFileName(basename(file))) hooks.ignoreFile(file);
        return false;
      },
      onSkippedProductWorktrees: (path, entryCount) => {
        hooks.notKept();
        reportSkippedWorktrees(diagnostics, basePath)(path, entryCount);
      },
      selectDirectory: (directory) => {
        if (directory.charCodeAt(directory.lastIndexOf(sep) + 1) === DOT) return false;
        if (capturedEntry(directory, true)) {
          hooks.notKept();
          if (searchDirectorySelection(directory, {}, diagnostics) === false) return false;
        }
        return hooks.enter(directory) ? undefined : false;
      },
      beforeAttempt: () => {
        assertCapturedToolInvocationCurrent();
        callOptions.beforeAttempt?.();
      },
      beforeAsyncAttempt: async () => {
        assertCapturedToolInvocationCurrent();
        await callOptions.beforeAsyncAttempt?.();
      },
      assertPath: (path) => {
        if (capturedEntry(path, false)) assertCapturedInputPathContext(path);
      },
      site: 'tools.find.skip-directory',
    });
  };
  const listed = await projectFileList(
    basePath, walkOptions.includeProductWorktrees === true, walk, isCapturedInputPath,
    () => walkOptions.shouldContinue?.() === false,
  );
  walkOptions.signal?.throwIfAborted();
  callOptions.beforeAttempt?.();
  assertCapturedToolInvocationCurrent();
  const files = listed.files.filter((file) => matchesPatterns?.(file) !== false && selectFile?.(file) !== false);
  return { files, ignoreFiles: listed.ignoreFiles };
}

/**
 * Files a mode that reads text may open. A file the owner's read rules restrict
 * is never read or reported, and the result says how many were held back.
 */
export async function withholdRestrictedFiles(
  files: string[],
  diagnostics: FindDiagnostics,
  readAccessFilter: ReadAccessFilter | undefined,
): Promise<string[]> {
  if (!readAccessFilter) return files;
  const { allowed, restricted } = await partitionByReadAccess(files, (file) => file, readAccessFilter);
  const note = accessRestrictedNote(restricted.length);
  if (note) addFindWarning(diagnostics, note);
  return allowed;
}

/** Files stat-ed or read at once during a search (at most this many file texts are held before scanning). */
export const SEARCH_READ_CONCURRENCY = 16;

const SEARCH_CACHE_MAX = 50;
/** Upper bound, in characters, on the paths and match text one service keeps for cached content searches. */
const SEARCH_CACHE_MAX_CHARS = 64 * 1024 * 1024;

function makeSearchCacheKey(key: CacheKey): string {
  return JSON.stringify([key.pattern, key.glob, key.path, key.flags]);
}

export interface ImportGraphLike {
  findImports(file: string): string[];
  findDependents(file: string): string[];
  getWarnings?(): string[];
}

/** One file's symbols as parsed, before any query's filters, with what produced them. */
export interface FileSymbols {
  readonly source: 'tree_sitter' | 'regex_fallback';
  readonly symbols: ReadonlyArray<{ readonly name: string; readonly kind: SymbolKind; readonly line: number; readonly exported: boolean }>;
}

/** Files whose parsed symbols one service keeps; the oldest entry is dropped first. */
const SYMBOL_CACHE_MAX_FILES = 20_000;

export interface FindRuntimeOptions {
  /** The rg program content search hands its first pass to; null never uses one. Default: rg on PATH, when there is one. */
  readonly ripgrep?: string | null | undefined;
}

export class FindRuntimeService {
  private readonly searchCache = new Map<string, { value: CacheValue; accessedAt: number; chars: number }>();
  private readonly symbolCache = new Map<string, { size: number; mtimeMs: number; value: FileSymbols }>();
  private readonly ripgrepOption: string | null | undefined;

  constructor(options: FindRuntimeOptions = {}) {
    this.ripgrepOption = options.ripgrep;
  }

  /** The rg program for content search's first pass, or null when there is none. */
  ripgrep(): string | null {
    return this.ripgrepOption !== undefined ? this.ripgrepOption : hostRipgrep();
  }

  /** The symbols parsed for `file` when it has the same size and modification time; a changed file parses again. */
  symbolsGet(file: string, size: number, mtimeMs: number): FileSymbols | undefined {
    const entry = this.symbolCache.get(file);
    return entry && entry.size === size && entry.mtimeMs === mtimeMs ? entry.value : undefined;
  }

  symbolsSet(file: string, size: number, mtimeMs: number, value: FileSymbols): void {
    this.symbolCache.delete(file);
    if (this.symbolCache.size >= SYMBOL_CACHE_MAX_FILES) {
      const oldest = this.symbolCache.keys().next().value;
      if (oldest !== undefined) this.symbolCache.delete(oldest);
    }
    this.symbolCache.set(file, { size, mtimeMs, value });
  }

  searchCacheGet(key: CacheKey): CacheValue | null {
    const cacheKey = makeSearchCacheKey(key);
    const entry = this.searchCache.get(cacheKey);
    if (!entry) return null;
    entry.accessedAt = Date.now();
    return entry.value;
  }

  searchCacheSet(key: CacheKey, value: CacheValue): void {
    const cacheKey = makeSearchCacheKey(key);
    // What the entry holds: the paths it lists, and each matched file's path, any
    // content it kept, and its match and context line text.
    let chars = 0;
    for (const file of value.files) chars += file.length;
    for (const [file, entry] of value.matchedFiles) {
      chars += file.length + entry.content.length;
      for (const match of entry.matches) {
        chars += match.text.length;
        for (const line of match.context_before ?? []) chars += line.length;
        for (const line of match.context_after ?? []) chars += line.length;
      }
    }
    // A result this large would evict everything else and still not fit.
    if (chars > SEARCH_CACHE_MAX_CHARS) { this.searchCache.delete(cacheKey); return; }
    this.searchCache.delete(cacheKey);
    let total = chars;
    for (const entry of this.searchCache.values()) total += entry.chars;
    while (this.searchCache.size > 0 && (this.searchCache.size >= SEARCH_CACHE_MAX || total > SEARCH_CACHE_MAX_CHARS)) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [candidateKey, candidateValue] of this.searchCache) {
        if (candidateValue.accessedAt < oldestTime) {
          oldestTime = candidateValue.accessedAt;
          oldestKey = candidateKey;
        }
      }
      if (!oldestKey) break;
      total -= this.searchCache.get(oldestKey)!.chars;
      this.searchCache.delete(oldestKey);
    }
    this.searchCache.set(cacheKey, { value, accessedAt: Date.now(), chars });
  }

  async searchCacheIsValid(cached: CacheValue): Promise<boolean> {
    const entries = Array.from(cached.fileMtimes.entries());
    const stats = await Promise.all(entries.map(([filePath]) => statSearchFile(filePath)));
    for (let i = 0; i < entries.length; i++) {
      const stat = stats[i]!;
      if (!stat || stat.mtimeMs !== entries[i]![1]) return false;
    }
    return true;
  }

  /**
   * The import graph for `projectRoot`: the one graph per root that edit and
   * repo-map read too (intelligence/import-graph.ts), patched for every edit
   * this process makes and rebuilt after a command may have changed files.
   */
  async getImportGraph(projectRoot: string): Promise<ImportGraphLike> {
    const { projectImportGraph } = await import('../../intelligence/import-graph.js');
    try {
      return await projectImportGraph(projectRoot);
    } catch (err) {
      const warning = `Import graph build failed; relationship results may be incomplete: ${summarizeError(err)}`;
      logger.warn('[find] Import graph build failed', { projectRoot, error: summarizeError(err) });
      // Nothing is held for a failed build; the next call builds again.
      return { findImports: () => [], findDependents: () => [], getWarnings: () => [warning] };
    }
  }
}
