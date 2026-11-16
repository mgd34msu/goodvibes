import { relative, isAbsolute, sep } from 'node:path';
import { paginateFindResult } from './pagination.js';
import type { FindSearchOptions } from './shared.js';
import { assertCapturedToolReadAccess } from '../shared/captured-input-tools.js';
import { uriToPath } from '../../intelligence/index.js';
import type { CodeIntelligence } from '../../intelligence/index.js';
import { partitionByReadAccess, accessRestrictedNote, type ReadAccessFilter } from '../shared/read-access.js';
import { summarizeError } from '../../utils/error-display.js';
import type { ReferencesQuery, OutputOptions } from './shared.js';
import {
  addBudgetStopWarning,
  addDiscoveryCutWarning,
  addFindWarning,
  addSearchSkipWarnings,
  collectFilesForSearch,
  createFindDiagnostics,
  createSearchSkips,
  makeCountResult,
  makeFilesResult,
  makeLocationsResult,
  readSearchFile,
  withFindWarnings,
  validateSearchPath,
} from './shared.js';

/**
 * The part of the code-intelligence facade the find tool uses. `lookupReferences`
 * says whether the language server answered; `getSymbols` and `hasTreeSitter`
 * serve symbols mode. An instance without them is asked only what it has.
 */
export type FindCodeIntelligence = Pick<CodeIntelligence, 'getEnclosingScope'>
  & Partial<Pick<CodeIntelligence, 'getReferences' | 'lookupReferences' | 'getSymbols' | 'hasTreeSitter'>>;

/** What the language server said about the references at a position. */
type ServerReferences =
  | { readonly state: 'answered'; readonly locations: readonly import('../../intelligence/lsp/protocol.js').Location[] }
  | { readonly state: 'no-server' | 'failed'; readonly reason: string };

async function askServer(ci: FindCodeIntelligence | undefined, file: string, line: number, column: number): Promise<ServerReferences> {
  if (!ci) return { state: 'no-server', reason: 'no code intelligence is attached to this tool' };
  if (ci.lookupReferences) {
    const lookup = await ci.lookupReferences(file, line, column);
    if (lookup.status === 'ok') return { state: 'answered', locations: lookup.items };
    const reason = [lookup.reason, ...lookup.next].join(' ');
    return { state: lookup.status === 'no-server' || lookup.status === 'unsupported' ? 'no-server' : 'failed', reason };
  }
  // An instance that reports no status: a non-empty list is an answer, an empty one cannot be told from no server.
  const locations = ci.getReferences ? await ci.getReferences(file, line, column) : [];
  return locations.length > 0
    ? { state: 'answered', locations }
    : { state: 'no-server', reason: 'no language server answered (the attached code intelligence reports no status, and returned no references)' };
}

function within(basePath: string, file: string): boolean {
  const rel = relative(basePath, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function withFallbackReason<T extends Record<string, unknown>>(
  result: T,
  reason: string,
): T & { fallback_reason: string } {
  return { ...result, fallback_reason: reason };
}

async function scanReferencesQuery(
  query: ReferencesQuery,
  output: OutputOptions,
  projectRoot: string,
  walkOptions: FindSearchOptions = {},
  readAccessFilter?: ReadAccessFilter,
  intelligence?: FindCodeIntelligence | (() => Promise<FindCodeIntelligence>),
): Promise<Record<string, unknown>> {

  // Lines are one-based here, as in every other find result; the language
  // server counts from zero.
  if (!Number.isInteger(query.line) || query.line < 1) {
    return { error: `references 'line' is one-based (the line number find results report); got ${String(query.line)}. Nothing was searched.` };
  }
  const basePath = validateSearchPath(query.path, projectRoot, walkOptions.allowOutsideProject);
  if (typeof basePath === 'object') return basePath;
  const sourcePath = validateSearchPath(query.file, projectRoot, walkOptions.allowOutsideProject);
  if (typeof sourcePath === 'object') return sourcePath;

  interface ReferenceLocation {
    file: string;
    line: number;
  }
  let locations: ReferenceLocation[] = [];
  let skippedInvalidLspUris = 0;
  const diagnostics = createFindDiagnostics();

  await assertCapturedToolReadAccess(sourcePath);
  let restrictedCount = 0;
  /** Drops locations in files the read gate holds back; names are not shown either. */
  const readable = async (found: ReferenceLocation[]): Promise<ReferenceLocation[]> => {
    const files = [...new Set(found.map((l) => l.file))];
    const { restricted } = await partitionByReadAccess(files, (f) => f, readAccessFilter);
    if (restricted.length === 0) return found;
    const denied = new Set(restricted);
    restrictedCount += found.filter((l) => denied.has(l.file)).length;
    return found.filter((l) => !denied.has(l.file));
  };
  const noteRestricted = (): void => {
    const note = accessRestrictedNote(restrictedCount);
    if (note) addFindWarning(diagnostics, note);
  };
  let server: ServerReferences;
  try {
    const ci = typeof intelligence === 'function' ? await intelligence() : intelligence;
    server = await askServer(ci, sourcePath, query.line - 1, query.column);
  } catch (err) {
    server = { state: 'failed', reason: `the language-server lookup failed: ${summarizeError(err)}` };
  }
  if (server.state === 'answered') {
    // The server's answer is the result, an empty one included: no text scan follows it.
    let outside = 0;
    for (const loc of server.locations) {
      try {
        const filePath = uriToPath(loc.uri);
        // `path` scopes the answer the same way it scopes the text search.
        if (!within(basePath, filePath)) { outside++; continue; }
        locations.push({ file: filePath, line: loc.range.start.line + 1 });
      } catch (err) {
        skippedInvalidLspUris++;
        addFindWarning(diagnostics, `Skipped invalid LSP reference URI '${loc.uri}': ${summarizeError(err)}`);
      }
    }
    if (outside > 0) addFindWarning(diagnostics, `${outside} reference(s) outside path '${query.path ?? '.'}' were left out; widen path to include them.`);

    locations = await readable(locations);
    noteRestricted();
    const source = skippedInvalidLspUris > 0 ? 'lsp_with_invalid_uri_skips' : 'lsp';
    const extra = skippedInvalidLspUris > 0 ? { invalid_lsp_uri_count: skippedInvalidLspUris } : {};
    if (output.format === 'count_only') {
      return withFindWarnings({ ...makeCountResult(locations.length, source), ...extra }, diagnostics.warnings);
    }
    if (output.format === 'files_only') {
      const uniqueFiles = [...new Set(locations.map((l) => l.file))];
      return withFindWarnings({ ...makeFilesResult(uniqueFiles, locations.length, source), ...extra }, diagnostics.warnings);
    }
    return withFindWarnings({ ...makeLocationsResult(locations, locations.length, source), ...extra }, diagnostics.warnings);
  }
  const lspFallbackReason = `${server.reason}; matched the symbol name as text`;

  if (!query.symbol) {
    return withFindWarnings(
      withFallbackReason(
        makeLocationsResult([], 0, 'grep_fallback'),
        `${lspFallbackReason}; no symbol supplied for grep fallback`,
      ),
      diagnostics.warnings,
    );
  }

  let regex: RegExp;
  try {
    regex = new RegExp(`\\b${query.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  } catch {
    return { error: `Invalid symbol name: ${query.symbol}` };
  }

  const files = await collectFilesForSearch(basePath, undefined, diagnostics, walkOptions);
  const skips = createSearchSkips();
  if (walkOptions.shouldContinue?.() === false) addDiscoveryCutWarning(diagnostics, files.length);
  for (const [fileIndex, file] of files.entries()) {
    walkOptions.signal?.throwIfAborted();
    walkOptions.beforeAttempt?.();
    if (walkOptions.shouldContinue?.() === false) {
      addBudgetStopWarning(diagnostics, fileIndex, files.length, locations.length, 'reference(s)');
      break;
    }

    const read = await readSearchFile(file, diagnostics, skips);
    if (read === null) continue;
    if (!read.text.includes(query.symbol)) continue;
    const lines = read.text.split('\n');
    for (let i = 0; i < lines.length; i++) {

      regex.lastIndex = 0;
      if (regex.test(lines[i]!)) {
        locations.push({ file, line: i + 1 });
      }
    }
  }

  addSearchSkipWarnings(diagnostics, skips);
  locations = await readable(locations);
  noteRestricted();

  if (output.format === 'count_only') {
    return withFindWarnings(
      withFallbackReason(makeCountResult(locations.length, 'grep_fallback'), lspFallbackReason),
      diagnostics.warnings,
    );
  }
  if (output.format === 'files_only') {
    const uniqueFiles = [...new Set(locations.map((l) => l.file))];
    return withFindWarnings(
      withFallbackReason(makeFilesResult(uniqueFiles, locations.length, 'grep_fallback'), lspFallbackReason),
      diagnostics.warnings,
    );
  }
  return withFindWarnings(
    withFallbackReason(makeLocationsResult(locations, locations.length, 'grep_fallback'), lspFallbackReason),
    diagnostics.warnings,
  );
}

export async function executeReferencesQuery(...args: Parameters<typeof scanReferencesQuery>): Promise<Record<string, unknown>> {
  return paginateFindResult(await scanReferencesQuery(...args), args[1]);
}
