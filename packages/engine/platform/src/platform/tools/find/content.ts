import type { FindSearchOptions } from './shared.js';
import { paginateFindResult } from './pagination.js';
import type { WalkDirOptions } from '../../utils/walk-dir.js';
import { assertCapturedToolAccessCurrent, hasCapturedToolInvocation } from '../shared/captured-input-tools.js';
import { ripgrepCandidates, ripgrepSupersetPattern } from './ripgrep.js';
import { isAbsolute, relative } from 'node:path';
import { judgmentPort } from '@goodvibes/engine/errors';
import { decisionOrClassic } from '../../runtime/decision-policy.js';
import { contentMatchView, contentRank } from '../batteries/content-rank.js';
import type { ContentQuery, OutputOptions, ContentMatch, CachedMatchedFiles } from './shared.js';
import { summarizeError } from '../../utils/error-display.js';
import { createSafeRegex } from '../../utils/safe-regex.js';
import {
  collectFilesForSearch,
  createFindDiagnostics,
  createSearchSkips,
  addDiscoveryCutWarning,
  addFindWarning,
  addSearchSkipWarnings,
  makeCountResult,
  makeFilesResult,
  makeLocationsResult,
  readSearchFile,
  SEARCH_READ_CONCURRENCY,
  statSearchFile,
  FindRuntimeService,
  validateSearchPath,
  withFindWarnings,
} from './shared.js';
import type { AdmittedRegex } from '@goodvibes/engine/errors';
import { partitionByReadAccess, accessRestrictedNote, type ReadAccessFilter } from '../shared/read-access.js';
import type { FindCodeIntelligence } from './references.js';

type MatchedFiles = Map<string, { content: string; matches: ContentMatch[] }>;

/**
 * A copy of the matches alone, sharing no match object with the original. The
 * cache hands out one entry to every later call, and `expand_to` writes into the
 * matches it is given. Cached entries carry no file text: it is re-read when a
 * query needs it, so a search on a common token does not pin the repository in memory.
 */
function cachedMatches(source: MatchedFiles): CachedMatchedFiles {
  return new Map(Array.from(source, ([file, entry]) => [file, { matches: entry.matches.map((match) => ({ ...match })) }] as const));
}

/** A cached entry's matches as a search's own, with no file text (`content` empty) and no match object shared with the cache. */
function fromCache(source: CachedMatchedFiles): MatchedFiles {
  return new Map(Array.from(source, ([file, entry]) => [file, { content: '', matches: entry.matches.map((match) => ({ ...match })) }] as const));
}

/** The decision site the content-rank reading is logged under. */
export const CONTENT_RANK_SITE = 'tools.find-content-ranked';

/**
 * Ranked mode: orders the matched files by the `engine.tools.content-rank`
 * reading of each against the searched pattern, best first. Every matched
 * file is kept; the reading only sets the order.
 */
async function rankMatchedFiles(
  matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>,
  pattern: string,
  projectRoot: string,
): Promise<Map<string, { content: string; matches: ContentMatch[] }>> {
  return decisionOrClassic(() => rankDecisionMatchedFiles(matchedFiles, pattern, projectRoot), async () => {
    await assertCapturedToolAccessCurrent();
    return new Map([...matchedFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

async function rankDecisionMatchedFiles(matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>, pattern: string, projectRoot: string): Promise<Map<string, { content: string; matches: ContentMatch[] }>> {
  const candidates = Array.from(matchedFiles, ([file, { matches }]) => ({
    id: file,
    content: contentMatchView(relative(projectRoot, file) || file, matches),
  }));
  await assertCapturedToolAccessCurrent();
  const { ranked } = await contentRank.rerank(judgmentPort(CONTENT_RANK_SITE), pattern, candidates, {
    site: CONTENT_RANK_SITE,
  });
  return new Map(ranked.map(({ id }) => [id, matchedFiles.get(id)!] as const));
}

interface CacheKey {
  pattern: string;
  glob: string;
  path: string;
  flags: string;
}

async function scanContentQuery(
  query: ContentQuery,
  output: OutputOptions,
  runtime: FindRuntimeService,
  projectRoot: string,
  readAccessFilter?: ReadAccessFilter,
  options: FindSearchOptions = {},
  intelligence?: () => Promise<FindCodeIntelligence>,
): Promise<Record<string, unknown>> {
  const current = () => {
    options.signal?.throwIfAborted(); options.beforeAttempt?.();
    if (options.assertCurrent !== options.beforeAttempt) options.assertCurrent?.();
  };
  current();
  const walkOptions: WalkDirOptions = { ...options, beforeAttempt: current };
  const validatedPath = validateSearchPath(query.path, projectRoot, options.allowOutsideProject);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  let format = output.format ?? 'matches';
  const ctxBefore = output.context_before ?? 0;
  const ctxAfter = output.context_after ?? 0;
  const diagnostics = createFindDiagnostics();

  if (format === 'signatures' || format === 'full') {
    return { error: `Output format '${format}' is only valid for symbols mode` };
  }
  if (format === 'with_stats' || format === 'with_preview') {
    // `output` is shared by every query of a call, so a format meant for another
    // mode is answered with the closest content format, and the call says so.
    addFindWarning(diagnostics, `Output format '${format}' is only valid for files mode; content mode returned 'matches' instead.`);
    format = 'matches';
  }
  if (query.preview_replace !== undefined && format !== 'matches' && format !== 'context') {
    addFindWarning(diagnostics, `preview_replace was ignored: it applies only to output formats 'matches' and 'context', not '${format}'.`);
  }
  if (query.multiline) {
    addFindWarning(diagnostics, "multiline has no effect in content mode: each line is matched on its own, so a pattern cannot span lines. Search for one line of the text, or use the edit tool's multiline for replacements across lines.");
  }

  let rawPattern: string;
  if (query.pattern_base64) {
    rawPattern = Buffer.from(query.pattern_base64, 'base64').toString('utf8');
  } else if (query.pattern) {
    rawPattern = query.pattern;
  } else {
    return { error: 'content mode requires pattern or pattern_base64' };
  }

  const searchedPattern = rawPattern;
  if (query.whole_word) {
    rawPattern = `\\b(?:${rawPattern})\\b`;
  }

  const flags = [query.case_sensitive === false ? 'i' : '', 'g'].join('');

  await using regex = await createSafeRegex(rawPattern, flags, { ...options, assertCurrent: current, operation: 'find content' });

  const files = await collectFilesForSearch(basePath, query.glob, diagnostics, walkOptions);
  const discoveryCut = options.shouldContinue?.() === false;
  // Read-side deny enforcement: a file whose read the gate would hold behind an
  // ask never has its content returned. content mode is a content surface in
  // EVERY format (even files_only/locations reveal that the pattern matched a
  // file), so the filter is applied to every file the search is about to
  // report, and the count withheld is surfaced. Only reported files are asked
  // about, so a search over many candidates does not read each one.
  let restrictedCount = 0;
  const onlyReadable = async (reported: readonly string[]): Promise<string[]> => {
    const { allowed, restricted } = await partitionByReadAccess(reported, (f) => f, readAccessFilter);
    restrictedCount += restricted.length;
    regex.assertCurrent();
    return allowed;
  };
  const noteRestricted = (): void => {
    const restrictedNote = accessRestrictedNote(restrictedCount);
    if (restrictedNote) addFindWarning(diagnostics, restrictedNote);
  };

  const skips = createSearchSkips();
  const literal = requiredLiteral(searchedPattern, query.case_sensitive === false);
  const firstPass = async (): Promise<ReadonlySet<string> | null> => {
    const pattern = await ripgrepPattern(runtime, regex, rawPattern, query.case_sensitive === false, files.length);
    return pattern ? ripgrepFirstPass(pattern, basePath, files, options.signal) : null;
  };

  if (query.negate) {
    const nonMatchingFiles: string[] = [];
    if (discoveryCut) addDiscoveryCutWarning(diagnostics, files.length);
    // Files rg finds no match in are still read: a binary or unreadable file is not "text without the pattern".
    const candidates = await firstPass();
    const scan = new BatchedLineScan(regex);
    const textFiles: string[] = [];
    for (let start = 0; start < files.length; start += SEARCH_READ_CONCURRENCY) {
      if (options.shouldContinue?.() === false) {
        addFindWarning(diagnostics, `Stopped at the time budget: checked ${start} of ${files.length} files, so the list of non-matching files is incomplete. `
          + "Narrow 'path' or 'glob', or pass a larger timeout_ms.");
        break;
      }
      // A binary file is not "text without the pattern": readSearchFile skips it.
      const chunk = files.slice(start, start + SEARCH_READ_CONCURRENCY);
      const reads = await Promise.all(chunk.map((file) => readSearchFile(file, diagnostics, skips)));
      for (const [offset, read] of reads.entries()) {
        if (read === null) continue;
        const file = chunk[offset]!;
        textFiles.push(file);
        if (candidates && !candidates.has(file)) continue;
        if (literal !== undefined && !literal.test(read.text)) continue;
        await scan.add(file, read.text);
      }
    }
    const matched = new Set((await scan.finish()).map((hit) => hit.file));
    for (const file of textFiles) if (!matched.has(file)) nonMatchingFiles.push(file);
    addSearchSkipWarnings(diagnostics, skips);
    const reported = await onlyReadable(nonMatchingFiles);
    noteRestricted();
    if (format === 'count_only') return withFindWarnings(makeCountResult(reported.length), diagnostics.warnings);
    regex.assertCurrent();
    return withFindWarnings(makeFilesResult(reported, reported.length), diagnostics.warnings);
  }

  const cacheKey: CacheKey = { pattern: JSON.stringify([rawPattern, format, ctxBefore, ctxAfter]), glob: query.glob ?? '', path: basePath, flags };
  await assertCapturedToolAccessCurrent();
  const cachedEntry = runtime.searchCacheGet(cacheKey);
  // A fresh directory reading may change eligibility without touching a file's
  // mtime. Reuse content only for the same current enumeration and order.
  const sameFiles = cachedEntry?.files.length === files.length
    && cachedEntry.files.every((file, index) => file === files[index]);
  const cacheValid = cachedEntry && sameFiles ? await runtime.searchCacheIsValid(cachedEntry) : false;
  walkOptions.signal?.throwIfAborted();
  walkOptions.beforeAttempt?.();

  let matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>;
  let totalMatches: number;
  let scanStoppedAt: number | undefined;
  let candidates: ReadonlySet<string> | null = null;
  let passedStats: Promise<void> | undefined;
  const fileMtimesForCache = new Map<string, number>();

  if (cacheValid && cachedEntry) {
    matchedFiles = fromCache(cachedEntry.matchedFiles);
    totalMatches = cachedEntry.totalMatches;
  } else {
    matchedFiles = new Map<string, { content: string; matches: ContentMatch[] }>();
    totalMatches = 0;
    // Where the host has rg, it names the files that may hold a match and only
    // those are read; the rest cannot match. Each file read is read once (stat,
    // then one read; text or binary is decided from the bytes in hand) and its
    // lines go to the isolated regex executor in batches of many files, one
    // round trip per batch.
    const plan = await ripgrepPattern(runtime, regex, rawPattern, query.case_sensitive === false, files.length);
    if (plan) candidates = await ripgrepFirstPass(plan, basePath, files, options.signal);
    const scanFiles = candidates ? files.filter((file) => candidates!.has(file)) : files;
    const passed = files.length - scanFiles.length;
    // A broad result is the one a later page asks for again: the files rg passed
    // over are stat-ed beside the reads, so the result is cached and checked by
    // modification time like any other. A narrow one is not (rg answers again
    // in less time than the stats take).
    if (candidates && scanFiles.length * BROAD_RESULT_SHARE >= files.length) {
      passedStats = statPassedOver(files.filter((file) => !candidates!.has(file)), fileMtimesForCache);
    }
    const scan = new BatchedLineScan(regex);
    for (let start = 0; start < scanFiles.length; start += SEARCH_READ_CONCURRENCY) {
      // The call's time budget ran out: stop with what was found and say how far the search got.
      if (options.shouldContinue?.() === false) { scanStoppedAt = passed + start; break; }
      // A few files are stat-ed and read at once; the scan still receives them in list order.
      // The mtime is taken by the stat before the read: a file that changes in between is cached as
      // old text under the old mtime, so the next call sees the newer mtime and rereads it.
      const chunk = scanFiles.slice(start, start + SEARCH_READ_CONCURRENCY);
      const reads = await Promise.all(chunk.map(async (file) => {
        const info = await statSearchFile(file);
        return { file, info, read: await readSearchFile(file, diagnostics, skips, info) };
      }));
      for (const { file, info, read } of reads) {
        fileMtimesForCache.set(file, info?.mtimeMs ?? 0);
        if (read === null) continue;
        // A pattern with a required literal cannot match a file without it.
        if (literal !== undefined && !literal.test(read.text)) continue;
        await scan.add(file, read.text);
      }
    }
    for (const hit of await scan.finish()) {
      const lines = hit.searchable.split('\n');
      const fileMatches: ContentMatch[] = [];
      for (const i of hit.lines) {
        const match: ContentMatch = { file: hit.file, line: i + 1, text: lines[i]! };
        if (format === 'context') {
          match.context_before = lines.slice(Math.max(0, i - ctxBefore), i);
          match.context_after = lines.slice(i + 1, i + 1 + ctxAfter);
        }
        fileMatches.push(match);
        totalMatches++;
      }
      matchedFiles.set(hit.file, { content: hit.content, matches: fileMatches });
    }
    await passedStats;
  }
  addSearchSkipWarnings(diagnostics, skips);

  if (scanStoppedAt === undefined && discoveryCut && !cacheValid) scanStoppedAt = files.length;
  if (scanStoppedAt !== undefined) {
    addFindWarning(diagnostics, `Stopped at the time budget: searched ${scanStoppedAt} of ${files.length} files${discoveryCut ? ' (finding the files was itself cut short, so more exist)' : ''} and found ${totalMatches} match(es) so far. `
      + "Narrow 'path' or 'glob', or pass a larger timeout_ms, to search the rest.");
  }

  // A partial scan must never be served later as if it were the whole answer.
  // The entry is stored before the read filter runs: it describes the files,
  // not who may see them, and every call filters its own copy, so a restriction
  // that is later lifted (or applied) is honoured without a changed file.
  // A search rg narrowed is kept only when every file it passed over was stat-ed.
  if (!query.ranked && !query.preview_replace && !query.relationships && scanStoppedAt === undefined
    && (candidates === null || passedStats !== undefined)) {
    runtime.searchCacheSet(cacheKey, {
      files,
      matchedFiles: cachedMatches(matchedFiles),
      totalMatches,
      fileMtimes: fileMtimesForCache,
    });
  }

  // The filter is the sole authority over what is reported, for fresh and
  // cached results alike (a cached entry may predate a mode change).
  if (readAccessFilter && matchedFiles.size > 0) {
    const readable = new Set(await onlyReadable(Array.from(matchedFiles.keys())));
    if (readable.size < matchedFiles.size) {
      const kept = new Map<string, { content: string; matches: ContentMatch[] }>();
      let keptMatches = 0;
      for (const [file, entry] of matchedFiles) {
        if (readable.has(file)) {
          kept.set(file, entry);
          keptMatches += entry.matches.length;
        }
      }
      matchedFiles = kept;
      totalMatches = keptMatches;
    }
  }
  noteRestricted();

  if (query.ranked && matchedFiles.size > 1) {
    matchedFiles = await rankMatchedFiles(matchedFiles, searchedPattern, projectRoot);
  }

  const expandTo = output.expand_to;
  if (expandTo === 'function' || expandTo === 'class') {
    const ci = intelligence ? await intelligence() : undefined;
    if (!ci) addFindWarning(diagnostics, `expand_to '${expandTo}' was not applied: no code intelligence is available to this tool.`);
    for (const [file, entry] of matchedFiles) {
      if (!ci) break;
      // Cached entries keep no text; the file is unchanged since the cache entry was checked.
      const content = entry.content !== '' ? entry.content : (await readSearchFile(file, diagnostics, createSearchSkips()))?.text ?? '';
      for (const m of entry.matches) {
        try {
          const scope = await ci.getEnclosingScope(file, content, m.line);
          if (scope) {
            m.startLine = scope.startLine;
            m.endLine = scope.endLine;
          }
        } catch (err) {
          addFindWarning(
            diagnostics,
            `Could not expand match scope in '${file}' at line ${m.line}: ${summarizeError(err)}`,
          );
        }
      }
    }
  }

  if (format === 'count_only') {
    regex.assertCurrent();
    return withFindWarnings(makeCountResult(totalMatches, undefined, matchedFiles.size), diagnostics.warnings);
  }
  if (format === 'files_only') {
    regex.assertCurrent();
    return withFindWarnings(makeFilesResult(Array.from(matchedFiles.keys()), matchedFiles.size), diagnostics.warnings);
  }
  if (format === 'locations') {
    const locations: Array<{ file: string; line: number }> = [];
    for (const [file, { matches }] of matchedFiles) {
      for (const m of matches) {
        locations.push({ file, line: m.line });
      }
    }
    regex.assertCurrent();
    return withFindWarnings(makeLocationsResult(locations, totalMatches), diagnostics.warnings);
  }

  if (format === 'matches' || format === 'context') {
    const results: Array<{
      file: string;
      line: number;
      text: string;
      replaced?: string | undefined;
      startLine?: number | undefined;
      endLine?: number | undefined;
      context_before?: string[] | undefined;
      context_after?: string[] | undefined;
    }> = [];
    for (const [, { matches }] of matchedFiles) {
      for (const m of matches) {
        let displayText = m.text;
        let replacedText: string | undefined;
        if (query.preview_replace !== undefined) {
          replacedText = await regex.replace(m.text, query.preview_replace);
        }
        if (output.max_line_length && displayText.length > output.max_line_length) {
          displayText = displayText.slice(0, output.max_line_length) + '...';
        }
        if (replacedText !== undefined && output.max_line_length && replacedText.length > output.max_line_length) {
          replacedText = replacedText.slice(0, output.max_line_length) + '...';
        }
        const entry: (typeof results)[number] = { file: m.file, line: m.line, text: displayText };
        if (replacedText !== undefined) entry.replaced = replacedText;
        if (m.startLine !== undefined) entry.startLine = m.startLine;
        if (m.endLine !== undefined) entry.endLine = m.endLine;
        if (format === 'context') {
          entry.context_before = m.context_before;
          entry.context_after = m.context_after;
        }
        results.push(entry);
      }
    }

    if (query.relationships) {
      // The graph covers the whole project, so `importedBy` is not cut off at the searched
      // path. A searched path outside the project gets a graph of its own, and says so.
      const fromRoot = relative(projectRoot, basePath);
      const inProject = !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + '/');
      const graphRoot = inProject ? projectRoot : basePath;
      const importGraph = await runtime.getImportGraph(graphRoot);
      const relMap: Record<string, { imports: string[]; importedBy: string[] }> = {};
      const related = new Map<string, { imports: string[]; importedBy: string[] }>();
      for (const file of matchedFiles.keys()) {
        related.set(file, { imports: importGraph.findImports(file), importedBy: importGraph.findDependents(file) });
      }
      // Files the read gate holds back are neither named nor counted as importers.
      const named = [...new Set([...related.values()].flatMap((entry) => [...entry.imports, ...entry.importedBy]))];
      const { allowed } = await partitionByReadAccess(named, (f) => f, readAccessFilter);
      const readable = new Set(allowed);
      for (const [file, entry] of related) {
        relMap[file] = { imports: entry.imports.filter((f) => readable.has(f)), importedBy: entry.importedBy.filter((f) => readable.has(f)) };
      }
      const restrictedNote = accessRestrictedNote(named.length - readable.size);
      if (restrictedNote) addFindWarning(diagnostics, restrictedNote);
      if (!inProject) addFindWarning(diagnostics, `Relationships were built from '${graphRoot}' only: 'importedBy' lists importers inside that path, not the whole project.`);
      regex.assertCurrent();
      return withFindWarnings({ matches: results, count: totalMatches, relationships: relMap }, [
        ...diagnostics.warnings,
        ...(importGraph.getWarnings?.() ?? []),
      ]);
    }

    regex.assertCurrent();
    return withFindWarnings({ matches: results, count: totalMatches }, diagnostics.warnings);
  }

  regex.assertCurrent();
  return withFindWarnings(makeCountResult(totalMatches), diagnostics.warnings);
}

/** Fewer files than this are read directly: starting rg would cost more than it saves. */
const RIPGREP_MIN_FILES = 64;
/** rg named at least one file in this many: the result is broad, and cached for its later pages. */
const BROAD_RESULT_SHARE = 4;
/** A file modified this recently before its stat may have changed after rg read it. */
const RACY_MTIME_MS = 2_000;

/**
 * Records the modification times of files rg found no match in. They are
 * stat-ed after rg read them, so a file modified within {@link RACY_MTIME_MS}
 * of its stat is recorded as unknown (-1, which no stat returns): the cached
 * result then fails its check and the next search runs again.
 */
async function statPassedOver(files: readonly string[], mtimes: Map<string, number>): Promise<void> {
  const infos = await Promise.all(files.map((file) => statSearchFile(file)));
  const now = Date.now();
  for (const [index, file] of files.entries()) {
    const info = infos[index];
    mtimes.set(file, info && Math.abs(now - info.mtimeMs) >= RACY_MTIME_MS ? info.mtimeMs : -1);
  }
}

/**
 * The rg program and the pattern to give it for this search (ripgrep.ts), or
 * null when rg is not used: none on the host, too few files, a contract's
 * captured input (each read there is authorised one file at a time), a pattern
 * rg cannot be given with the same meaning, or a pattern that matches an empty
 * line (the line split counts one after a final newline; rg does not).
 */
async function ripgrepPattern(
  runtime: FindRuntimeService,
  regex: AdmittedRegex,
  pattern: string,
  caseInsensitive: boolean,
  fileCount: number,
): Promise<{ readonly rg: string; readonly pattern: string } | null> {
  const rg = runtime.ripgrep();
  if (!rg || fileCount < RIPGREP_MIN_FILES || hasCapturedToolInvocation()) return null;
  const translated = ripgrepSupersetPattern(pattern, caseInsensitive);
  if (translated === null) return null;
  if ((await regex.matchingLines('')).length > 0) return null;
  return { rg, pattern: translated };
}

/** The files rg says may hold a match, or null when rg did not answer (the search then reads every file). */
async function ripgrepFirstPass(
  plan: { readonly rg: string; readonly pattern: string },
  basePath: string,
  files: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string> | null> {
  try {
    return await ripgrepCandidates(plan.rg, basePath, files, plan.pattern, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // rg could not be started: the search reads every file, as on a host without rg.
    return null;
  }
}

/** Characters of file text sent to the regex executor in one message. */
const SCAN_BATCH_CHARS = 4 * 1024 * 1024;
/** Files sent to the regex executor in one message. */
const SCAN_BATCH_FILES = 1024;

interface ScanHit {
  readonly file: string;
  /** The text as read. */
  readonly content: string;
  /** The text the lines were matched in (CRLF read as LF). */
  readonly searchable: string;
  /** Zero-based matching line numbers, ascending. */
  readonly lines: readonly number[];
}

/**
 * Line matching for many files in one executor round trip per batch. The
 * files' texts are joined with a newline, so the joined lines are exactly each
 * file's lines in order, and the executor's line numbers map back to a file and
 * its own line by the line counts. The executor matches each line on its own,
 * as before, so no match can span two files.
 */
class BatchedLineScan {
  private batch: Array<{ file: string; content: string; searchable: string; lineCount: number }> = [];
  private batchChars = 0;
  private readonly hits: ScanHit[] = [];

  constructor(private readonly regex: AdmittedRegex) {}

  async add(file: string, content: string): Promise<void> {
    // Lines are matched without their CRLF terminator, so `foo$` matches a Windows file too.
    const searchable = content.includes('\r\n') ? content.replace(/\r\n/g, '\n') : content;
    this.batch.push({ file, content, searchable, lineCount: countLines(searchable) });
    this.batchChars += searchable.length + 1;
    if (this.batchChars >= SCAN_BATCH_CHARS || this.batch.length >= SCAN_BATCH_FILES) await this.flush();
  }

  async finish(): Promise<readonly ScanHit[]> {
    await this.flush();
    return this.hits;
  }

  private async flush(): Promise<void> {
    const batch = this.batch;
    if (batch.length === 0) return;
    this.batch = [];
    this.batchChars = 0;
    const matched = await this.regex.matchingLines(batch.length === 1 ? batch[0]!.searchable : batch.map((entry) => entry.searchable).join('\n'));
    let entryIndex = 0;
    let firstLine = 0;
    let current: number[] = [];
    const close = (): void => {
      if (current.length === 0) return;
      const entry = batch[entryIndex]!;
      this.hits.push({ file: entry.file, content: entry.content, searchable: entry.searchable, lines: current });
      current = [];
    };
    for (const line of matched) {
      while (line >= firstLine + batch[entryIndex]!.lineCount) {
        close();
        firstLine += batch[entryIndex]!.lineCount;
        entryIndex++;
      }
      current.push(line - firstLine);
    }
    close();
  }
}

/** Lines in `text` as `split('\n')` counts them, without building the array. */
function countLines(text: string): number {
  let count = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/**
 * The text every match of `pattern` must contain, when the pattern is plain
 * text (letters, digits, spaces and escaped punctuation, no operators). A file
 * without it is not sent to the regex executor. Case-insensitive search uses
 * it only when it is ASCII, where lowercasing both sides is exact.
 */
function requiredLiteral(pattern: string, caseInsensitive: boolean): { test(text: string): boolean } | undefined {
  let literal = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return undefined;
      literal += next;
      i++;
      continue;
    }
    if ('^$.|?*+()[]{}'.includes(ch)) return undefined;
    literal += ch;
  }
  if (literal.length === 0) return undefined;
  if (!caseInsensitive) return { test: (text) => text.includes(literal) };
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7F]*$/.test(literal)) return undefined;
  const lower = literal.toLowerCase();
  return { test: (text) => text.toLowerCase().includes(lower) };
}

export async function executeContentQuery(...args: Parameters<typeof scanContentQuery>): Promise<Record<string, unknown>> {
  return paginateFindResult(await scanContentQuery(...args), args[1]);
}
