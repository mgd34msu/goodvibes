import type { FindSearchOptions } from './shared.js';
import { paginateFindResult } from './pagination.js';
import { assertCapturedInputPathContext } from '../../contract/input-authority.js';
import { DirectoryWalk, type WalkDirOptions } from '../../utils/walk-dir.js';
import { isAbsolute, relative } from 'node:path';
import { lstat, stat } from 'node:fs/promises';
import type { FilesQuery, FindDiagnostics, OutputOptions } from './shared.js';
import {
  addDiscoveryCutWarning,
  addFindWarning,
  buildIgnoreFileMatcher,
  collectGlobFiles,
  createFindDiagnostics,
  findNestedIgnoreFiles,
  directoryIgnoreFiles,
  heldSearchFiles,
  NESTED_IGNORE_FILES_SHOWN,
  SEARCH_READ_CONCURRENCY,
  makeCountResult,
  makeFilesResult,
  matchesGlob,
  validateSearchPath,
  withFindWarnings,
} from './shared.js';
import { summarizeError } from '../../utils/error-display.js';
import { createSafeRegex } from '../../utils/safe-regex.js';
import { accessRestrictedNote, partitionByReadAccess, type ReadAccessFilter } from '../shared/read-access.js';

/** The warning files mode adds when the time budget ends its per-file pass before every file was checked. */
function addFilesBudgetStopWarning(diagnostics: FindDiagnostics, checked: number, total: number): void {
  addFindWarning(diagnostics, `Stopped at the time budget: checked ${checked} of ${total} files, so the list is incomplete. `
    + "Narrow 'path' or 'patterns', or pass a larger timeout_ms, to check the rest.");
}

async function scanFilesQuery(
  query: FilesQuery,
  output: OutputOptions,
  projectRoot: string,
  readAccessFilter?: ReadAccessFilter,
  capturedReadAccess?: ReadAccessFilter,
  options: FindSearchOptions = {},
): Promise<Record<string, unknown>> {
  const before = JSON.stringify([query, output]);
  const current = () => {
    options.signal?.throwIfAborted(); options.beforeAttempt?.();
    if (options.assertCurrent !== options.beforeAttempt) options.assertCurrent?.();
    if (JSON.stringify([query, output]) !== before) throw new Error('Find regex request changed');
  };
  current();
  const walkOptions: WalkDirOptions = { ...options, beforeAttempt: current };
  const validatedPath = validateSearchPath(query.path, projectRoot, options.allowOutsideProject);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const walk = new DirectoryWalk(basePath);
  const patterns = query.patterns ?? ['**/*'];
  const excludePatterns = query.exclude ?? [];
  const includeHidden = query.include_hidden ?? false;
  const followSymlinks = query.follow_symlinks ?? false;
  const respectGitignore = query.respect_gitignore !== false;
  const diagnostics = createFindDiagnostics();
  const compiledExcludes: Array<InstanceType<typeof Bun.Glob>> = [];
  for (const pattern of excludePatterns) {
    try {
      compiledExcludes.push(new Bun.Glob(pattern));
    } catch (err) {
      addFindWarning(diagnostics, `Skipped invalid exclude glob '${pattern}': ${summarizeError(err)}`);
    }
  }

  const modifiedAfterMs = query.modified_after ? new Date(query.modified_after).getTime() : undefined;
  if (modifiedAfterMs !== undefined && Number.isNaN(modifiedAfterMs)) {
    return { error: `Invalid modified_after date: ${query.modified_after}` };
  }
  const modifiedBeforeMs = query.modified_before ? new Date(query.modified_before).getTime() : undefined;
  if (modifiedBeforeMs !== undefined && Number.isNaN(modifiedBeforeMs)) {
    return { error: `Invalid modified_before date: ${query.modified_before}` };
  }

  const relativeBase = relative(projectRoot, basePath);
  const outside = relativeBase === '..' || relativeBase.startsWith('../') || isAbsolute(relativeBase);
  const ignoreRoot = outside ? basePath : projectRoot;
  // In a captured view this filter also validates original-owner authority
  // before the synchronous matcher opens .gitignore.
  const rootIgnoreFiles = directoryIgnoreFiles(ignoreRoot);
  if (respectGitignore && capturedReadAccess) {
    for (const file of rootIgnoreFiles) if (!await capturedReadAccess(file)) throw new Error('root ignore-file read is access-restricted');
  }
  const gitignoreMatcher = respectGitignore
    ? buildIgnoreFileMatcher(rootIgnoreFiles, diagnostics)
    : null;
  // A listing without hidden entries or followed links comes from the
  // project's held file list, which a repeated query checks by directory
  // stamps instead of walking, and which records each listed directory's
  // ignore files, so nested ones are reported without a walk of their own.
  const held = includeHidden || followSymlinks ? null : await heldSearchFiles(basePath, patterns, diagnostics, walkOptions);
  if (respectGitignore) {
    const nested = held
      ? held.ignoreFiles.filter((file) => !rootIgnoreFiles.includes(file))
      : await findNestedIgnoreFiles(basePath, rootIgnoreFiles, walk, walkOptions, diagnostics);
    if (nested.length > 0) {
      const count = !held && nested.length >= NESTED_IGNORE_FILES_SHOWN ? `${nested.length} or more` : `${nested.length}`;
      addFindWarning(
        diagnostics,
        `Nested .gitignore and .ignore files are not applied by find files; ${count} nested file(s) detected, including '${nested[0]}'.`,
      );
    }
  }

  await using hasContentRegex = query.has_content
    ? await createSafeRegex(query.has_content, '', { ...options, assertCurrent: current, operation: 'find files has_content' }) : undefined;

  const scannedFiles = held
    ? held.files
    : Array.from(await collectGlobFiles(basePath, patterns, includeHidden, followSymlinks, diagnostics, walk, walkOptions));
  if (options.shouldContinue?.() === false) addDiscoveryCutWarning(diagnostics, scannedFiles.length);
  const matchedFiles = new Set<string>();
  for (const file of scannedFiles) {
    // Ignore rules are written relative to the directory holding the .gitignore.
    if (gitignoreMatcher && gitignoreMatcher(relative(ignoreRoot, file))) continue;
    const excluded = compiledExcludes.some((excl) => matchesGlob(excl, file, basePath));
    if (excluded) continue;
    matchedFiles.add(file);
  }

  const needStats =
    query.min_size !== undefined ||
    query.max_size !== undefined ||
    query.is_empty !== undefined ||
    modifiedAfterMs !== undefined ||
    modifiedBeforeMs !== undefined ||
    query.sort_by === 'size' ||
    query.sort_by === 'modified' ||
    output.format === 'with_stats' ||
    output.format === 'with_preview';

  interface FileEntry {
    path: string;
    size?: number | undefined;
    mtimeMs?: number | undefined;
  }

  let entries: FileEntry[] = Array.from(matchedFiles).map((p) => ({ path: p }));

  let budgetStopped = false;
  if (needStats) {
    const withStats: FileEntry[] = [];
    const statOf = followSymlinks ? stat : lstat;
    // A few files are stat-ed at once off the event loop; between groups the call's
    // cancel and time budget are checked, and a budget stop keeps what was stat-ed.
    for (let start = 0; start < entries.length; start += SEARCH_READ_CONCURRENCY) {
      current();
      if (options.shouldContinue?.() === false) {
        addFilesBudgetStopWarning(diagnostics, start, entries.length);
        budgetStopped = true;
        break;
      }
      const chunk = entries.slice(start, start + SEARCH_READ_CONCURRENCY);
      await Promise.all(chunk.map(async (entry) => {
        try {
          const s = await statOf(entry.path);
          entry.size = s.size;
          entry.mtimeMs = s.mtimeMs;
        } catch (err) {
          addFindWarning(diagnostics, `Could not stat '${entry.path}'; filters and sorting may be incomplete: ${summarizeError(err)}`);
        }
      }));
      for (const entry of chunk) {
        if (query.min_size !== undefined && (entry.size ?? 0) < query.min_size) continue;
        if (query.max_size !== undefined && (entry.size ?? 0) > query.max_size) continue;
        if (query.is_empty === true && (entry.size ?? 0) !== 0) continue;
        if (query.is_empty === false && (entry.size ?? 0) === 0) continue;
        if (modifiedAfterMs !== undefined && (entry.mtimeMs ?? 0) < modifiedAfterMs) continue;
        if (modifiedBeforeMs !== undefined && (entry.mtimeMs ?? 0) >= modifiedBeforeMs) continue;
        withStats.push(entry);
      }
    }
    entries = withStats;
  }

  // Read-side deny enforcement: a file whose read is currently restricted keeps
  // its PATH in listings (hiding existence would be dishonest) but never has its
  // CONTENT read or returned. Files mode is path-oriented, so restricted entries
  // are marked, not dropped, except has_content, which cannot be verified
  // without reading, so restricted entries are excluded from that content query.
  const restrictedPaths = new Set<string>(
    (await partitionByReadAccess(entries, (e) => e.path, readAccessFilter)).restricted.map((e) => e.path),
  );

  if (hasContentRegex) {
    const filtered: FileEntry[] = [];
    for (const [index, entry] of entries.entries()) {
      current();
      if (options.shouldContinue?.() === false) {
        if (!budgetStopped) addFilesBudgetStopWarning(diagnostics, index, entries.length);
        break;
      }
      if (restrictedPaths.has(entry.path)) continue; // cannot read to verify content
      try {
        if (capturedReadAccess && !await capturedReadAccess(entry.path)) throw new Error('file read is access-restricted');
        assertCapturedInputPathContext(entry.path);
        const text = await Bun.file(entry.path).text();
        if (await hasContentRegex.test(text)) filtered.push(entry);
      } catch (err) {
        addFindWarning(diagnostics, `Could not read '${entry.path}' for has_content filtering: ${summarizeError(err)}`);
      }
    }
    entries = filtered;
  }

  const restrictedNote = accessRestrictedNote(restrictedPaths.size);
  if (restrictedNote) addFindWarning(diagnostics, restrictedNote);
  const isRestricted = (p: string): boolean => restrictedPaths.has(p);
  // Paths under the project root are listed relative to it (stated once as
  // `root`), as content mode does; a path outside it stays absolute.
  const shown = (p: string): string => {
    const rel = relative(projectRoot, p);
    return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) ? rel : p;
  };

  const sortBy = query.sort_by ?? 'name';
  const sortOrder = query.sort_order ?? 'asc';
  const dir = sortOrder === 'desc' ? -1 : 1;

  entries.sort((a, b) => {
    if (sortBy === 'size') return ((a.size ?? 0) - (b.size ?? 0)) * dir;
    if (sortBy === 'modified') return ((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)) * dir;
    hasContentRegex?.assertCurrent();
    return a.path.localeCompare(b.path) * dir;
  });

  const format = output.format ?? 'files_only';
  if (format === 'matches' || format === 'context' || format === 'locations' || format === 'signatures' || format === 'full') {
    // `output` is shared by every query of a call, so a format meant for another
    // mode still gets the plain file list, with the substitution stated.
    addFindWarning(diagnostics, `Output format '${format}' does not apply to files mode; the plain file list was returned (files mode formats: count_only, files_only, with_stats, with_preview).`);
  }
  if (format === 'count_only') {
    hasContentRegex?.assertCurrent();
    return withFindWarnings(makeCountResult(entries.length), diagnostics.warnings);
  }
  if (format === 'with_stats') {
    const result = entries.map((e) => ({
      file: shown(e.path),
      size: e.size,
      modified: e.mtimeMs !== undefined ? new Date(e.mtimeMs).toISOString() : undefined,
      ...(isRestricted(e.path) ? { access_restricted: true } : {}),
    }));
    hasContentRegex?.assertCurrent();
    return withFindWarnings({ root: projectRoot, files: result, count: result.length }, diagnostics.warnings);
  }
  if (format === 'with_preview') {
    const previewLines = output.preview_lines ?? 3;
    const result: Array<{ file: string; preview: string[]; access_restricted?: boolean }> = [];
    for (const entry of entries) {
      if (isRestricted(entry.path)) {
        // Withhold content: show the path, an empty preview, and the flag.
        result.push({ file: shown(entry.path), preview: [], access_restricted: true });
        continue;
      }
      let preview: string[] = [];
      try {
        if (capturedReadAccess && !await capturedReadAccess(entry.path)) throw new Error('file read is access-restricted');
        assertCapturedInputPathContext(entry.path);
        const text = await Bun.file(entry.path).text();
        preview = text.split('\n').slice(0, previewLines);
      } catch (err) {
        addFindWarning(diagnostics, `Could not read '${entry.path}' for preview: ${summarizeError(err)}`);
      }
      result.push({ file: shown(entry.path), preview });
    }
    hasContentRegex?.assertCurrent();
    return withFindWarnings({ root: projectRoot, files: result, count: result.length }, diagnostics.warnings);
  }

  const filesResult = { root: projectRoot, ...makeFilesResult(entries.map((e) => shown(e.path)), entries.length) };
  const accessRestrictedFiles = entries.map((e) => e.path).filter(isRestricted).map(shown);
  hasContentRegex?.assertCurrent();
  return withFindWarnings(
    accessRestrictedFiles.length > 0
      ? { ...filesResult, access_restricted: accessRestrictedFiles }
      : filesResult,
    diagnostics.warnings,
  );
}

export async function executeFilesQuery(...args: Parameters<typeof scanFilesQuery>): Promise<Record<string, unknown>> {
  return paginateFindResult(await scanFilesQuery(...args), args[1]);
}
