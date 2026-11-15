import type { FindSearchOptions } from './shared.js';
import { paginateFindResult } from './pagination.js';
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

function getAstGrepLang(
  astGrep: AstGrepModule,
  filePath: string,
  override?: StructuralQuery['lang'],
): { parse: (src: string) => { root(): { findAll(pat: string): Array<{ text(): string; range(): { start: { line: number } } }> } } } | null {
  const lang = override ?? extname(filePath).slice(1).toLowerCase();
  switch (lang) {
    case 'ts':
    case 'mts':
    case 'cts': return astGrep.ts;
    case 'tsx': return astGrep.tsx;
    case 'js':
    case 'mjs':
    case 'cjs': return astGrep.js;
    case 'jsx': return astGrep.jsx;
    case 'css': return astGrep.css;
    case 'html': return astGrep.html;
    default: return null;
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
  const discovered = await collectFilesForSearch(basePath, query.glob, diagnostics, walkOptions);
  if (walkOptions.shouldContinue?.() === false) addDiscoveryCutWarning(diagnostics, discovered.length);
  const files = await withholdRestrictedFiles(discovered, diagnostics, walkOptions.readAccessFilter);

  interface StructuralMatch { file: string; line: number; text: string }
  const allMatches: StructuralMatch[] = [];
  const matchedFiles = new Set<string>();
  let totalMatches = 0;
  let unsupportedFiles = 0;
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

    const parser = getAstGrepLang(astGrep, file, query.lang);
    if (!parser) { unsupportedFiles++; continue; }

    const content = await readTextFile(file, diagnostics);
    if (content === null) continue;

    let root: ReturnType<typeof parser.parse>;
    try {
      root = parser.parse(content);
    } catch (err) {
      addFindWarning(diagnostics, `Skipped '${file}': it could not be parsed as ${query.lang ?? extname(file).slice(1)}: ${summarizeError(err)}`);
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
      const text = match.text();
      const line = match.range().start.line + 1;
      allMatches.push({ file, line, text });
      matchedFiles.add(file);
      totalMatches++;
    }
  }

  // A pattern that no file accepted is a mistake in the pattern, not an empty result.
  if (searchedFiles === 0 && patternFailures > 0) {
    return { error: `Invalid structural pattern '${query.pattern}': ${firstPatternError}. No files were searched.` };
  }
  if (patternFailures > 0) {
    addFindWarning(diagnostics, `The pattern could not be applied to ${patternFailures} file(s) and they were skipped: ${firstPatternError}`);
  }
  if (unsupportedFiles > 0) {
    addFindWarning(diagnostics, `Skipped ${unsupportedFiles} file(s) whose language structural mode does not support (ts, tsx, js, jsx, css, html); use content mode for those.`);
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
