import { extname } from 'node:path';
import { logger } from '../../utils/logger.js';
import { CodeIntelligence } from '../../intelligence/facade.js';
import type { SymbolInfo } from '../../intelligence/tree-sitter/queries.js';
import { summarizeError } from '../../utils/error-display.js';

const SIGNATURE_PATTERNS: RegExp[] = [
  /^\s*export\s+(async\s+)?function\s+/,
  /^\s*export\s+(abstract\s+)?class\s+/,
  /^\s*export\s+interface\s+/,
  /^\s*export\s+type\s+\w+/,
  /^\s*export\s+enum\s+/,
  /^\s*export\s+const\s+/,
  /^\s*export\s+let\s+/,
  /^\s*export\s+var\s+/,
  /^\s*export\s+default\s+/,
  /^(async\s+)?function\s+\w+/,
  /^(abstract\s+)?class\s+\w+/,
];

const EXPORT_DECLARATION_RE =
  /^\s*export\s+(?:async\s+)?(?:abstract\s+)?(function|class|interface|type|enum|const|let|var)\s+(\w+)/;

const KIND_MAP: Record<string, string> = {
  function: 'function',
  class: 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  const: 'constant',
  let: 'variable',
  var: 'variable',
};

const TS_KIND_MAP: Record<string, string> = {
  const: 'constant',
  let: 'variable',
  var: 'variable',
};

export function extractOutlineRegex(lines: string[], includeLineNumbers: boolean): string {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (SIGNATURE_PATTERNS.some((p) => p.test(line))) {
      const lineNo = i + 1;
      let sig = line.trimEnd();
      const braceIdx = sig.indexOf('{');
      if (braceIdx !== -1) {
        sig = sig.slice(0, braceIdx).trimEnd();
      }
      result.push(includeLineNumbers ? `${String(lineNo).padStart(5)} | ${sig}` : sig);
    }
  }
  return result.join('\n');
}

export function extractSymbolsRegex(lines: string[], includeLineNumbers: boolean): string {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(EXPORT_DECLARATION_RE);
    if (m) {
      const kw = m[1]!;
      const name = m[2]!;
      const kind = KIND_MAP[kw]! ?? 'export';
      const lineNo = i + 1;
      const entry = `${kind} ${name}`;
      result.push(includeLineNumbers ? `${String(lineNo).padStart(5)} | ${entry}` : entry);
    }
  }
  return result.join('\n');
}

function normalizeTsKind(kind: string): string {
  return TS_KIND_MAP[kind] ?? kind;
}

function formatOutlineEntries(
  entries: Array<{ line: number; signature: string }>,
  includeLineNumbers: boolean,
): string {
  return entries.map((e) => includeLineNumbers ? `${String(e.line).padStart(5)} | ${e.signature}` : e.signature).join('\n');
}

function formatSymbolEntries(symbols: SymbolInfo[], includeLineNumbers: boolean): string {
  return symbols
    .map((s) => {
      const kind = normalizeTsKind(s.kind);
      const entry = `${kind} ${s.name}`;
      return includeLineNumbers ? `${String(s.line).padStart(5)} | ${entry}` : entry;
    })
    .join('\n');
}

/** The parts of the code-intelligence facade the read tool uses; the optional ones are used when present. */
type ReadIntelligence = Pick<CodeIntelligence, 'getOutline' | 'getSymbols'> & Partial<Pick<CodeIntelligence, 'getSyntaxTree' | 'hasTreeSitter'>>;

function readIntelligence(filePath: string, supplied: ReadIntelligence | undefined): ReadIntelligence {
  return supplied ?? CodeIntelligence.forPath(filePath);
}

/**
 * Says why the line-pattern result is shown, naming the cause that applies:
 * the file's language has no grammar, the parser failed, or it parsed the file
 * and found nothing to list.
 */
function fallbackNote(what: 'outline' | 'symbols' | 'syntax tree', filePath: string, ci: ReadIntelligence, parserFailed: boolean): string {
  const ext = extname(filePath) || 'this file type';
  if (parserFailed) return `# Note: the tree-sitter parser failed on this file, so no ${what} could be read. Falling back to regex (line patterns: top-level declarations only).\n`;
  if (ci.hasTreeSitter?.(filePath) === false) {
    return `# Note: no tree-sitter grammar is installed for ${ext} files. Falling back to regex (line patterns: top-level declarations only).\n`;
  }
  return `# Note: tree-sitter parsed this file and found no ${what === 'symbols' ? 'exported symbols' : 'entries'}. Falling back to regex; the result may be empty.\n`;
}

export async function extractOutline(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
  codeIntelligence?: ReadIntelligence,
): Promise<string> {
  const ci = readIntelligence(filePath, codeIntelligence);
  let failed = false;
  try {
    const entries = await ci.getOutline(filePath, rawContent);
    if (entries.length > 0) return formatOutlineEntries(entries, includeLineNumbers);
  } catch (err) {
    failed = true;
    logger.debug('read tool: tree-sitter outline failed, using regex fallback', { filePath, error: summarizeError(err) });
  }
  return fallbackNote('outline', filePath, ci, failed) + extractOutlineRegex(lines, includeLineNumbers);
}

export async function extractSymbols(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
  codeIntelligence?: ReadIntelligence,
): Promise<string> {
  const ci = readIntelligence(filePath, codeIntelligence);
  let failed = false;
  try {
    const symbols = await ci.getSymbols(filePath, rawContent);
    const exported = symbols.filter((s) => s.exported);
    if (exported.length > 0) return formatSymbolEntries(exported, includeLineNumbers);
  } catch (err) {
    failed = true;
    logger.debug('read tool: tree-sitter symbols failed, using regex fallback', { filePath, error: summarizeError(err) });
  }
  return fallbackNote('symbols', filePath, ci, failed) + extractSymbolsRegex(lines, includeLineNumbers);
}

/**
 * The file's syntax tree: every structural node (declarations, blocks,
 * statements that hold others) with its type, name and line range, indented by
 * depth. Where `outline` lists signatures, this shows the shape of the code.
 */
export async function extractAst(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
  codeIntelligence?: ReadIntelligence,
): Promise<string> {
  const ci = readIntelligence(filePath, codeIntelligence);
  let failed = false;
  try {
    const tree = ci.getSyntaxTree ? await ci.getSyntaxTree(filePath, rawContent) : null;
    if (tree && tree.entries.length > 0) {
      const body = tree.entries.map((entry) => {
        const label = `${'  '.repeat(entry.depth)}${entry.type}${entry.name !== undefined ? ` ${entry.name}` : ''}`;
        const span = entry.startLine === entry.endLine ? `${entry.startLine}` : `${entry.startLine}-${entry.endLine}`;
        return includeLineNumbers ? `${span.padStart(11)} | ${label}` : `${label} (${span})`;
      }).join('\n');
      return tree.truncated
        ? `${body}\n# Note: the tree was cut (6 levels, 2000 nodes); read a line range for the rest.`
        : body;
    }
  } catch (err) {
    failed = true;
    logger.debug('read tool: tree-sitter syntax tree failed, using outline fallback', { filePath, error: summarizeError(err) });
  }
  return fallbackNote('syntax tree', filePath, ci, failed) + extractOutlineRegex(lines, includeLineNumbers);
}

export function formatContent(
  lines: string[],
  includeLineNumbers: boolean,
  range?: { start: number; end: number },
  maxPerItem?: number,
): string {
  let slice: string[];
  let startLine: number;

  if (range) {
    const start = Math.max(0, range.start - 1);
    const end = Math.min(lines.length, range.end);
    slice = lines.slice(start, end);
    startLine = range.start;
  } else {
    slice = lines;
    startLine = 1;
  }

  if (maxPerItem !== undefined) {
    slice = slice.slice(0, maxPerItem);
  }

  if (includeLineNumbers) {
    return slice.map((l, idx) => `${String(startLine + idx).padStart(5)} | ${l}`).join('\n');
  }
  return slice.join('\n');
}
