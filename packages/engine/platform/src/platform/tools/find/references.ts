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
  collectTextFiles,
  createFindDiagnostics,
  makeCountResult,
  makeFilesResult,
  makeLocationsResult,
  readTextFile,
  withFindWarnings,
  validateSearchPath,
} from './shared.js';

/** The part of the code-intelligence facade the find tool uses. */
export type FindCodeIntelligence = Pick<CodeIntelligence, 'getReferences' | 'getEnclosingScope'>;

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
  let lspFallbackReason = 'no language server answered (none is attached to this tool, or it returned no references); matched the symbol name as text';
  let skippedInvalidLspUris = 0;
  const diagnostics = createFindDiagnostics();

  await assertCapturedToolReadAccess(sourcePath);
  let restrictedCount = 0;
  /** Drops locations in files the read gate holds back; names are not shown either. */
  const readable = async (found: ReferenceLocation[]): Promise<ReferenceLocation[]> => {
    const files = [...new Set(found.map((l) => l.file))];
    const { allowed, restricted } = await partitionByReadAccess(files, (f) => f, readAccessFilter);
    if (restricted.length === 0) return found;
    const denied = new Set(restricted);
    restrictedCount += found.filter((l) => denied.has(l.file)).length;
    return found.filter((l) => !denied.has(l.file));
  };
  const noteRestricted = (): void => {
    const note = accessRestrictedNote(restrictedCount);
    if (note) addFindWarning(diagnostics, note);
  };
  try {
    const ci = typeof intelligence === 'function' ? await intelligence() : intelligence;
    const lspLocations = ci ? await ci.getReferences(sourcePath, query.line - 1, query.column) : [];
    if (lspLocations.length > 0) {
      for (const loc of lspLocations) {

        try {
          const filePath = uriToPath(loc.uri);
          locations.push({ file: filePath, line: loc.range.start.line + 1 });
        } catch (err) {
          skippedInvalidLspUris++;
          addFindWarning(diagnostics, `Skipped invalid LSP reference URI '${loc.uri}': ${summarizeError(err)}`);
        }
      }

      locations = await readable(locations);
      noteRestricted();
      const source = skippedInvalidLspUris > 0 ? 'lsp_with_invalid_uri_skips' : undefined;
      if (output.format === 'count_only') {
        return withFindWarnings(
          skippedInvalidLspUris > 0
            ? { ...makeCountResult(locations.length, source), invalid_lsp_uri_count: skippedInvalidLspUris }
            : makeCountResult(locations.length),
          diagnostics.warnings,
        );
      }
      if (output.format === 'files_only') {
        const uniqueFiles = [...new Set(locations.map((l) => l.file))];
        return withFindWarnings(
          skippedInvalidLspUris > 0
            ? {
                ...makeFilesResult(uniqueFiles, locations.length, source),
                invalid_lsp_uri_count: skippedInvalidLspUris,
              }
            : makeFilesResult(uniqueFiles, locations.length),
          diagnostics.warnings,
        );
      }
      return withFindWarnings(
        skippedInvalidLspUris > 0
          ? {
              ...makeLocationsResult(locations, locations.length, source),
              invalid_lsp_uri_count: skippedInvalidLspUris,
            }
          : makeLocationsResult(locations, locations.length),
        diagnostics.warnings,
      );
    }
  } catch (err) {
    lspFallbackReason = `lsp unavailable: ${summarizeError(err)}`;
  }

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

  const files = await collectTextFiles(basePath, diagnostics, walkOptions);
  if (walkOptions.shouldContinue?.() === false) addDiscoveryCutWarning(diagnostics, files.length);
  for (const [fileIndex, file] of files.entries()) {
    walkOptions.signal?.throwIfAborted();
    walkOptions.beforeAttempt?.();
    if (walkOptions.shouldContinue?.() === false) {
      addBudgetStopWarning(diagnostics, fileIndex, files.length, locations.length, 'reference(s)');
      break;
    }

    const content = await readTextFile(file, diagnostics);
    if (content === null) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {

      regex.lastIndex = 0;
      if (regex.test(lines[i]!)) {
        locations.push({ file, line: i + 1 });
      }
    }
  }

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
