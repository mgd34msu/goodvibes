import type { FindSearchOptions } from './shared.js';
import { paginateFindResult } from './pagination.js';
import { extname } from 'node:path';
import type { WalkDirOptions } from '../../utils/walk-dir.js';
import { CodeIntelligence } from '../../intelligence/index.js';
import type { OutputOptions, SymbolsQuery, SymbolKind, FileSymbols } from './shared.js';
import {
  collectFilesForSearch,
  createFindDiagnostics,
  createSearchSkips,
  addSearchSkipWarnings,
  FindRuntimeService,
  groupByKey,
  loadFileLines,
  makeCountResult,
  makeFilesResult,
  readSearchFile,
  statSearchFile,
  toSymbolKind,
  validateSearchPath,
  withFindWarnings,
  addFindWarning,
  addBudgetStopWarning,
  addDiscoveryCutWarning,
  withholdRestrictedFiles,
} from './shared.js';
import type { FindCodeIntelligence } from './references.js';
import { summarizeError } from '../../utils/error-display.js';
import { createSafeRegex } from '../../utils/safe-regex.js';

interface SymbolResult {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
}

/** Line patterns for a file no grammar can parse: declarations that start a line, top level only. */
const LINE_PATTERNS: ReadonlyArray<{ kind: SymbolKind; regex: RegExp; exported: boolean }> = [
  { kind: 'function', regex: /^export\s+(?:async\s+)?function\s+(\w+)/, exported: true },
  { kind: 'class', regex: /^export\s+(?:abstract\s+)?class\s+(\w+)/, exported: true },
  { kind: 'interface', regex: /^export\s+interface\s+(\w+)/, exported: true },
  { kind: 'type', regex: /^export\s+type\s+(\w+)\s*[=<{]/, exported: true },
  { kind: 'enum', regex: /^export\s+enum\s+(\w+)/, exported: true },
  { kind: 'constant', regex: /^export\s+const\s+(\w+)/, exported: true },
  { kind: 'variable', regex: /^export\s+(?:let|var)\s+(\w+)/, exported: true },
  { kind: 'function', regex: /^(?:async\s+)?function\s+(\w+)/, exported: false },
  { kind: 'class', regex: /^(?:abstract\s+)?class\s+(\w+)/, exported: false },
];

function lineSymbols(content: string): FileSymbols['symbols'] {
  const found: Array<FileSymbols['symbols'][number]> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:export|async|function|abstract|class)\b/.test(lines[i]!)) continue;
    const line = lines[i]!.trimStart();
    for (const { kind, regex, exported } of LINE_PATTERNS) {
      const name = line.match(regex)?.[1];
      if (name) { found.push({ name, kind, line: i + 1, exported }); break; }
    }
  }
  return found;
}

/** One instance for callers that supply none, so a direct call parses with the process's shared grammars. */
let defaultIntelligence: CodeIntelligence | undefined;
let defaultRuntime: FindRuntimeService | undefined;

async function scanSymbolsQuery(
  query: SymbolsQuery,
  output: OutputOptions,
  projectRoot: string,
  options: FindSearchOptions = {},
  runtime?: FindRuntimeService,
  intelligence?: () => Promise<FindCodeIntelligence>,
): Promise<Record<string, unknown>> {
  const current = () => {
    options.signal?.throwIfAborted(); options.beforeAttempt?.(); options.assertCurrent?.();
  };
  current();
  const walkOptions: WalkDirOptions = { ...options, beforeAttempt: current };
  const validatedPath = validateSearchPath(query.path, projectRoot, options.allowOutsideProject);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const kindFilter = query.kinds ? new Set(query.kinds) : null;
  const diagnostics = createFindDiagnostics();
  // `output` is shared by every query of a call, so options meant for another mode are named rather than silently dropped.
  if (output.format !== undefined && !['signatures', 'full', 'count_only', 'files_only'].includes(output.format)) {
    addFindWarning(diagnostics, `Output format '${output.format}' does not apply to symbols mode; the plain symbol list was returned (symbols mode formats: signatures, full, count_only, files_only).`);
  }
  if (output.context_before !== undefined || output.context_after !== undefined) {
    addFindWarning(diagnostics, 'context_before and context_after apply to content mode only and have no effect in symbols mode.');
  }

  const discovered = await collectFilesForSearch(basePath, undefined, diagnostics, walkOptions);
  if (options.shouldContinue?.() === false) addDiscoveryCutWarning(diagnostics, discovered.length);
  const files = await withholdRestrictedFiles(discovered, diagnostics, options.readAccessFilter);
  const symbols: SymbolResult[] = [];

  await using queryRegex = query.query
    ? await createSafeRegex(query.query, 'i', { ...options, assertCurrent: current, operation: 'find symbols query' }) : undefined;

  // The tool's one code-intelligence instance: the workspace's grammars and language files.
  const supplied = intelligence ? await intelligence() : undefined;
  const ci: Pick<CodeIntelligence, 'getSymbols' | 'hasTreeSitter'> = supplied?.getSymbols && supplied.hasTreeSitter
    ? supplied as Pick<CodeIntelligence, 'getSymbols' | 'hasTreeSitter'>
    : (defaultIntelligence ??= new CodeIntelligence({}));
  const cache = runtime ?? (defaultRuntime ??= new FindRuntimeService());
  const skips = createSearchSkips();
  let treeSitterFiles = 0;
  let regexFallbackFiles = 0;
  // Extensions read by line patterns, by why; said once per call.
  const lineOnly = new Map<string, Set<string>>();

  for (const [fileIndex, file] of files.entries()) {
    current();
    if (options.shouldContinue?.() === false) {
      addBudgetStopWarning(diagnostics, fileIndex, files.length, symbols.length, 'symbol(s)');
      break;
    }

    const info = await statSearchFile(file);
    let parsed = info ? cache.symbolsGet(file, info.size, info.mtimeMs) : undefined;
    if (!parsed) {
      const read = await readSearchFile(file, diagnostics, skips, info);
      if (read === null) continue;
      parsed = await parseSymbols(ci, file, read.text, diagnostics, current);
      if (info) cache.symbolsSet(file, info.size, info.mtimeMs, parsed);
    }
    if (parsed.source === 'tree_sitter') treeSitterFiles++;
    else {
      regexFallbackFiles++;
      const why = ci.hasTreeSitter(file) ? 'the parser failed on them' : 'no grammar is installed for their language';
      const exts = lineOnly.get(why) ?? new Set<string>();
      exts.add(extname(file).toLowerCase() || '(no extension)');
      lineOnly.set(why, exts);
    }
    for (const sym of parsed.symbols) {
      if (kindFilter && !kindFilter.has(sym.kind)) continue;
      if (query.exported_only && !query.include_private && !sym.exported) continue;
      if (queryRegex && !await queryRegex.test(sym.name)) continue;
      symbols.push({ name: sym.name, kind: sym.kind, file, line: sym.line, exported: sym.exported });
    }
  }
  addSearchSkipWarnings(diagnostics, skips);
  for (const [why, exts] of lineOnly) {
    addFindWarning(diagnostics, `Symbols for ${[...exts].join(', ')} files came from line patterns (${why}): declarations that start a line only; methods, members and nested declarations are not listed.`);
  }

  if (output.format === 'count_only') {
    queryRegex?.assertCurrent();
    return withFindWarnings({ ...makeCountResult(symbols.length), source: symbolSource(treeSitterFiles, regexFallbackFiles) }, diagnostics.warnings);
  }
  if (output.format === 'files_only') {
    const uniqueFiles = [...new Set(symbols.map((s) => s.file))];
    queryRegex?.assertCurrent();
    return withFindWarnings({ ...makeFilesResult(uniqueFiles, symbols.length), source: symbolSource(treeSitterFiles, regexFallbackFiles) }, diagnostics.warnings);
  }

  if (output.format === 'signatures' || output.format === 'full') {
    const fileContents = new Map<string, string[]>();
    const enriched: Array<Record<string, unknown>> = [];
    for (const sym of symbols) {
      let fileLines = fileContents.get(sym.file);
      if (!fileLines) {
        fileLines = await loadFileLines(sym.file);
        fileContents.set(sym.file, fileLines);
      }
      const entry: Record<string, unknown> = {
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        line: sym.line,
        exported: sym.exported,
      };
      const sigLines: string[] = [];
      for (let i = sym.line - 1; i < Math.min(sym.line + 10, fileLines.length); i++) {
        const l = fileLines[i]!;
        sigLines.push(l.trimEnd());
        if (/[{;]/.test(l)) break;
      }
      entry.signature = sigLines.join('\n');
      if (output.format === 'full') {
        let jsdoc = '';
        let j = sym.line - 2;
        if (j >= 0 && fileLines[j]?.trimStart().startsWith('*/')) {
          const docLines: string[] = [];
          while (j >= 0 && !(fileLines[j] ?? '').trimStart().startsWith('/**')) {
            docLines.unshift(fileLines[j]!);
            j--;
          }
          if (j >= 0) docLines.unshift(fileLines[j]!);
          jsdoc = docLines.join('\n');
        }
        if (jsdoc) entry.jsdoc = jsdoc;
        let container = '';
        for (let k = sym.line - 2; k >= Math.max(0, sym.line - 50); k--) {
          const cl = fileLines[k]?.trimStart() ?? '';
          if (/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/.test(cl)) {
            const m = cl.match(/class\s+(\w+)/);
            if (m) { container = m[1]!; break; }
          }
          if (/^(?:export\s+)?(?:namespace|module)\s+(\w+)/.test(cl)) {
            const m = cl.match(/(?:namespace|module)\s+(\w+)/);
            if (m) { container = m[1]!; break; }
          }
        }
        if (container) entry.container = container;
      }
      enriched.push(entry);
    }
    const groupBy = query.group_by ?? 'none';
    const grouped = groupByKey(enriched as Array<{ file: string; kind: string }>, groupBy);
    if (grouped) {
      queryRegex?.assertCurrent();
      return withFindWarnings({ symbols: grouped, count: symbols.length, source: symbolSource(treeSitterFiles, regexFallbackFiles) }, diagnostics.warnings);
    }
    queryRegex?.assertCurrent();
    return withFindWarnings({ symbols: enriched, count: symbols.length, source: symbolSource(treeSitterFiles, regexFallbackFiles) }, diagnostics.warnings);
  }

  const groupBy = query.group_by ?? 'none';
  const grouped = groupByKey(symbols, groupBy);
  if (grouped) {
    queryRegex?.assertCurrent();
    return withFindWarnings({ symbols: grouped, count: symbols.length, source: symbolSource(treeSitterFiles, regexFallbackFiles) }, diagnostics.warnings);
  }

  queryRegex?.assertCurrent();
  return withFindWarnings({ symbols, count: symbols.length, source: symbolSource(treeSitterFiles, regexFallbackFiles) }, diagnostics.warnings);
}

function symbolSource(treeSitterFiles: number, regexFallbackFiles: number): 'tree_sitter' | 'regex_fallback' | 'mixed' {
  if (treeSitterFiles > 0 && regexFallbackFiles > 0) return 'mixed';
  if (treeSitterFiles > 0) return 'tree_sitter';
  return 'regex_fallback';
}

/**
 * A file's symbols: the parser's when the file's language has a grammar (an
 * empty list is the answer, not a reason to guess), line patterns otherwise or
 * when the parser failed.
 */
async function parseSymbols(
  ci: Pick<CodeIntelligence, 'getSymbols' | 'hasTreeSitter'>,
  file: string,
  content: string,
  diagnostics: ReturnType<typeof createFindDiagnostics>,
  current: () => void,
): Promise<FileSymbols> {
  // Only the parser call is guarded: a cancellation must end the call, not be read as a parser failure.
  try {
    const found = await ci.getSymbols(file, content);
    if (found.length > 0 || ci.hasTreeSitter(file)) {
      return { source: 'tree_sitter', symbols: found.map((sym) => ({ name: sym.name, kind: toSymbolKind(sym.kind), line: sym.line, exported: sym.exported })) };
    }
  } catch (err) {
    current();
    addFindWarning(diagnostics, `Tree-sitter symbol extraction failed for '${file}'; used line patterns: ${summarizeError(err)}`);
  }
  return { source: 'regex_fallback', symbols: lineSymbols(content) };
}

export async function executeSymbolsQuery(...args: Parameters<typeof scanSymbolsQuery>): Promise<Record<string, unknown>> {
  return paginateFindResult(await scanSymbolsQuery(...args), args[1]);
}
