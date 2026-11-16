import type { FindSearchOptions } from './shared.js';
import { DEFAULT_PAGE_SIZE, paginateFindResult } from './pagination.js';
import { extname } from 'node:path';
import type { OutputOptions, StructuralQuery } from './shared.js';
import { addBudgetStopWarning, addDiscoveryCutWarning, addFindWarning, collectFilesForSearch, createFindDiagnostics, makeCountResult, makeFilesResult, makeLocationsResult, readTextFile, validateSearchPath, withFindWarnings, withholdRestrictedFiles } from './shared.js';
import { summarizeError } from '../../utils/error-display.js';

type AstGrepModule = typeof import('@ast-grep/napi');

let astGrepModulePromise: Promise<AstGrepModule> | null = null;

async function loadAstGrep(): Promise<AstGrepModule> {
  astGrepModulePromise ??= import('@ast-grep/napi');
  return astGrepModulePromise;
}

type StructuralLang = NonNullable<StructuralQuery['lang']>;

/** The parser for each extension structural mode reads; anything else is not a candidate. */
const LANG_BY_EXTENSION: Readonly<Record<string, StructuralLang>> = {
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  css: 'css', html: 'html', htm: 'html',
};

/**
 * The language a file is parsed as, decided from its name before it is
 * opened. `lang` with a `glob` parses every file the glob names as that
 * language (the caller named them); `lang` alone narrows the search to that
 * language's own extensions; neither uses the extension.
 */
function structuralLang(filePath: string, override: StructuralLang | undefined, glob: string | undefined): StructuralLang | null {
  const byExtension = LANG_BY_EXTENSION[extname(filePath).slice(1).toLowerCase()] ?? null;
  if (!override) return byExtension;
  if (glob) return override;
  return byExtension === override ? override : null;
}

type StructuralParser = { parse: (src: string) => { root(): { findAll(pat: string): Array<{ text(): string; range(): { start: { line: number } } }> } } };

function astGrepParser(astGrep: AstGrepModule, lang: StructuralLang): StructuralParser {
  switch (lang) {
    case 'ts': return astGrep.ts;
    case 'tsx': return astGrep.tsx;
    case 'js': return astGrep.js;
    case 'jsx': return astGrep.jsx;
    case 'css': return astGrep.css;
    case 'html': return astGrep.html;
  }
}

async function scanStructuralQuery(
  query: StructuralQuery,
  output: OutputOptions,
  projectRoot: string,
  walkOptions: FindSearchOptions = {},
): Promise<Record<string, unknown>> {
  const validatedPath = validateSearchPath(query.path, projectRoot, walkOptions.allowOutsideProject);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;

  if (!query.pattern) {
    return { error: 'structural mode requires pattern' };
  }

  let astGrep: AstGrepModule;
  try {
    astGrep = await loadAstGrep();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `structural mode requires @ast-grep/napi at runtime: ${message}` };
  }

  const format = output.format ?? 'matches';
  const diagnostics = createFindDiagnostics();
  // Candidates are chosen by name first: a file structural mode cannot parse is
  // never opened or put to the read filter.
  const unsupported = new Set<string>();
  const discovered = await collectFilesForSearch(basePath, query.glob, diagnostics, {
    ...walkOptions,
    selectFile: (file) => {
      if (walkOptions.selectFile?.(file) === false) return false;
      if (structuralLang(file, query.lang, query.glob) !== null) return true;
      unsupported.add(file);
      return false;
    },
  });
  if (walkOptions.shouldContinue?.() === false) addDiscoveryCutWarning(diagnostics, discovered.length);
  const files = await withholdRestrictedFiles(discovered, diagnostics, walkOptions.readAccessFilter);

  // Only rows a page can show keep their text: the window is the same one
  // pagination applies (offset, page size, per-file limit), so a broad pattern
  // over a large tree holds a file and a line per match, not every match's text.
  const keepText = format !== 'count_only' && format !== 'files_only' && format !== 'locations';
  const offset = output.offset ?? 0;
  const pageEnd = offset + (output.max_total_matches ?? output.max_results ?? DEFAULT_PAGE_SIZE);
  const perFile = output.max_per_item;
  const perFileCounts = new Map<string, number>();
  let eligibleIndex = 0;

  interface StructuralMatch { file: string; line: number; text?: string }
  const allMatches: StructuralMatch[] = [];
  const matchedFiles = new Set<string>();
  let totalMatches = 0;
  let searchedFiles = 0;
  let patternFailures = 0;
  let firstPatternError: string | undefined;

  for (const [fileIndex, file] of files.entries()) {
    walkOptions.signal?.throwIfAborted();
    walkOptions.beforeAttempt?.();
    if (walkOptions.shouldContinue?.() === false) {
      addBudgetStopWarning(diagnostics, fileIndex, files.length, totalMatches, 'match(es)');
      break;
    }

    const lang = structuralLang(file, query.lang, query.glob);
    if (!lang) continue;
    const parser = astGrepParser(astGrep, lang);

    const content = await readTextFile(file, diagnostics);
    if (content === null) continue;

    let root: ReturnType<typeof parser.parse>;
    try {
      root = parser.parse(content);
    } catch (err) {
      addFindWarning(diagnostics, `Skipped '${file}': it could not be parsed as ${lang}: ${summarizeError(err)}`);
      continue;
    }

    let matches: ReturnType<ReturnType<typeof parser.parse>['root']>['findAll'] extends (p: string) => infer R ? R : never;
    try {
      matches = root.root().findAll(query.pattern);
    } catch (err) {
      patternFailures++;
      firstPatternError ??= summarizeError(err);
      continue;
    }
    searchedFiles++;

    for (const match of matches) {
      totalMatches++;
      matchedFiles.add(file);
      if (format === 'count_only' || format === 'files_only') continue;
      const line = match.range().start.line + 1;
      let shown = false;
      if (keepText) {
        const seen = perFileCounts.get(file) ?? 0;
        perFileCounts.set(file, seen + 1);
        if (perFile === undefined || seen < perFile) {
          shown = eligibleIndex >= offset && eligibleIndex < pageEnd;
          eligibleIndex++;
        }
      }
      allMatches.push(shown ? { file, line, text: match.text() } : { file, line });
    }
  }

  // A pattern that no file accepted is a mistake in the pattern, not an empty result.
  if (searchedFiles === 0 && patternFailures > 0) {
    return { error: `Invalid structural pattern '${query.pattern}': ${firstPatternError}. No files were searched.` };
  }
  if (patternFailures > 0) {
    addFindWarning(diagnostics, `The pattern could not be applied to ${patternFailures} file(s) and they were skipped: ${firstPatternError}`);
  }
  const unsupportedFiles = unsupported.size;
  if (unsupportedFiles > 0) {
    addFindWarning(diagnostics, query.lang && !query.glob
      ? `Searched only ${query.lang} files: ${unsupportedFiles} file(s) with other extensions were skipped. To parse other files as ${query.lang}, name them with glob.`
      : `Skipped ${unsupportedFiles} file(s) whose language structural mode does not support (ts, tsx, js, jsx, css, html); use content mode for those.`);
  }

  if (format === 'count_only') {
    return withFindWarnings(makeCountResult(totalMatches, undefined, matchedFiles.size), diagnostics.warnings);
  }
  if (format === 'files_only') {
    return withFindWarnings(makeFilesResult(Array.from(matchedFiles), matchedFiles.size), diagnostics.warnings);
  }
  if (format === 'locations') {
    const locations = allMatches.map((m) => ({ file: m.file, line: m.line }));
    return withFindWarnings(makeLocationsResult(locations, totalMatches), diagnostics.warnings);
  }
  return withFindWarnings({ matches: allMatches, count: totalMatches }, diagnostics.warnings);
}

export async function executeStructuralQuery(...args: Parameters<typeof scanStructuralQuery>): Promise<Record<string, unknown>> {
  return paginateFindResult(await scanStructuralQuery(...args), args[1]);
}
