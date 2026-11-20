import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';
import { extname } from 'node:path';
import { logger } from '../../utils/logger.js';
import { CodeIntelligence } from '../../intelligence/index.js';
import type { EditItem, OccurrenceSpec, EditResult, EditResultStatus } from './types.js';
import { summarizeError } from '../../utils/error-display.js';
import { assertSafeRegexInput, compileSafeRegExp, createSafeRegex, safeRegExpExec } from '../../utils/safe-regex.js';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { editTarget, editTargetView } from '../batteries/edit-target.js';
import { judge } from '../../runtime/judge.js';
import { resolveEditText } from './edit-text.js';

type AstGrepModule = typeof import('@ast-grep/napi');
/** Why an edit was not applied, decided by the matcher that refused it. */
export type EditFailureStatus = Exclude<EditResultStatus, 'applied'>;
/** A refused edit: the message, the matcher's own status, and what to do next. */
export interface EditFailure { readonly error: string; readonly status: EditFailureStatus; readonly hint?: string | undefined }
type EditComputationResult =
  | { newContent: string; occurrencesReplaced: number; warning?: string | undefined }
  | EditFailure;

/** An input error from resolveEditText, which has no status of its own. */
function inputFailure(text: { error: string }): EditFailure {
  return { error: text.error, status: 'failed' };
}

function withExactFallbackWarning(
  result: { newContent: string; occurrencesReplaced: number } | EditFailure,
  warning: string,
): EditComputationResult {
  return 'error' in result ? result : { ...result, warning };
}

export { decodeBase64, resolveEditText } from './edit-text.js';

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}


/** Flags of the regex search; the replacement re-reads each match with the same ones. */
function regexSearchFlags(caseSensitive: boolean, multiline: boolean): string {
  return `${caseSensitive ? 'g' : 'gi'}${multiline ? 'sm' : ''}`;
}

/** A selected range no longer matches the pattern when it is read again for its captures. */
class RegexRecaptureError extends Error {}

/** The numeric-capture substitution of the edit API ($1, $2); not String.replace's full language. */
function substituteCaptures(replace: string, captures: readonly (string | undefined)[]): string {
  return replace.replace(/\$(\d+)/g, (_full, digit: string) => captures[parseInt(digit, 10)] ?? '');
}

/** The decision site the edit-target reading is logged under. */
export const EDIT_TARGET_SITE = 'tools.edit-fuzzy-line';

export function findAllPositions(
  content: string,
  find: string,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  whitespaceSensitive: boolean = true,
  multiline: boolean = false,
): { start: number; end: number }[] {
  const positions: { start: number; end: number }[] = [];

  if (mode !== 'regex' && find.length === 0) return positions;

  if (mode === 'regex') {
    const flags = regexSearchFlags(caseSensitive, multiline);
    assertSafeRegexInput(content, { operation: 'edit regex search' });
    const re = compileSafeRegExp(find, flags, { operation: 'edit regex search' });
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      positions.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
    return positions;
  }

  if (mode === 'fuzzy') {
    const normalizedFind = normalizeWhitespace(caseSensitive ? find : find.toLowerCase());
    if (!normalizedFind) return [];

    const tokens: { norm: string; origStart: number; origEnd: number }[] = [];
    const tokenRe = /\S+/g;
    let tm: RegExpExecArray | null;
    const compareContent = caseSensitive ? content : content.toLowerCase();
    while ((tm = tokenRe.exec(content)) !== null) {
      tokens.push({
        norm: compareContent.slice(tm.index, tm.index + tm[0].length),
        origStart: tm.index,
        origEnd: tm.index + tm[0].length,
      });
    }

    const findTokens = normalizedFind.split(' ').filter(Boolean);
    if (findTokens.length === 0) return [];

    for (let i = 0; i <= tokens.length - findTokens.length; i++) {
      let match = true;
      for (let j = 0; j < findTokens.length; j++) {
        if ((tokens[i + j]?.norm ?? '') !== findTokens[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        positions.push({
          start: tokens[i]?.origStart ?? 0,
          end: tokens[i + findTokens.length - 1]?.origEnd ?? 0,
        });
        // Windows never overlap, so an occurrence-all edit cannot replace the same tokens twice.
        i += findTokens.length - 1;
      }
    }
    return positions;
  }

  if (!whitespaceSensitive) {
    return findAllPositions(content, find, 'fuzzy', caseSensitive, true);
  }
  const needle = caseSensitive ? find : find.toLowerCase();
  const haystack = caseSensitive ? content : content.toLowerCase();
  let idx = 0;
  while (true) {
    const pos = haystack.indexOf(needle, idx);
    if (pos === -1) break;
    positions.push({ start: pos, end: pos + find.length });
    // Past the whole match: overlapping ranges would corrupt an occurrence-all edit.
    idx = pos + needle.length;
  }
  return positions;
}

export function applyHints(
  content: string,
  positions: { start: number; end: number }[],
  hints: EditItem['hints'],
  nearLine?: number,
): { positions: { start: number; end: number }[]; warning?: string | undefined } {
  if (!hints) return { positions };

  let filtered = positions;
  let warning: string | undefined;

  if (hints.after) {
    const anchorIdx = content.indexOf(hints.after);
    if (anchorIdx === -1) {
      return { positions: [], warning: `after anchor "${hints.after}" not found in file` };
    }
    const afterOffset = anchorIdx + hints.after.length;
    filtered = filtered.filter((pos) => pos.start >= afterOffset);
  }

  if (hints.before) {
    const anchorIdx = content.indexOf(hints.before);
    if (anchorIdx === -1) {
      return { positions: [], warning: `before anchor "${hints.before}" not found in file` };
    }
    filtered = filtered.filter((pos) => pos.end <= anchorIdx);
  }

  if (hints.in_function) {
    const name = hints.in_function;
    const scopeRe = new RegExp(
      `(?:function\\s+${escapeRegex(name)}\\s*\\(|(?:const|let|var)\\s+${escapeRegex(name)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>|${escapeRegex(name)}\\s*\\()`,
      'g',
    );
    filtered = filterByScope(content, filtered, scopeRe);
  }

  if (hints.in_class) {
    const name = hints.in_class;
    const scopeRe = new RegExp(`class\\s+${escapeRegex(name)}\\s*(?:extends[^{]+)?\\{`, 'g');
    filtered = filterByScope(content, filtered, scopeRe);
  }

  if (nearLine !== undefined && filtered.length > 1) {
    let best = filtered[0]!;
    let bestDist = Math.abs(lineNumberAt(content, best.start) - nearLine);
    for (const pos of filtered.slice(1)) {
      const dist = Math.abs(lineNumberAt(content, pos.start) - nearLine);
      if (dist < bestDist) {
        bestDist = dist;
        best = pos;
      }
    }
    filtered = [best];
  }

  return { positions: filtered, warning };
}

function filterByScope(
  content: string,
  positions: { start: number; end: number }[],
  scopeRe: RegExp,
): { start: number; end: number }[] {
  const scopes: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = scopeRe.exec(content)) !== null) {
    const scopeStart = m.index;
    let braceStart = content.indexOf('{', m.index + m[0].length - 1);
    if (braceStart === -1) continue;
    let depth = 0;
    let i = braceStart;
    for (; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    scopes.push({ start: scopeStart, end: i });
  }

  if (scopes.length === 0) return [];
  return positions.filter((pos) => scopes.some((scope) => pos.start >= scope.start && pos.end <= scope.end));
}

export function selectOccurrences(
  positions: { start: number; end: number }[],
  occurrence: OccurrenceSpec | undefined,
): { selected: { start: number; end: number }[] } | EditFailure {
  if (positions.length === 0) {
    return {
      error: 'Find string not found in file',
      status: 'not_found',
      hint: 'Check that the find string matches the file content exactly, including whitespace and line endings.',
    };
  }

  if (occurrence === undefined) {
    if (positions.length > 1) {
      return {
        error: `Ambiguous match: find string appears ${positions.length} times. Specify occurrence: 'first', 'last', 'all', or a number.`,
        status: 'ambiguous',
        hint: `Pattern matched ${positions.length} times, use occurrence: 'first', 'last', 'all', or a number (1-${positions.length}) to disambiguate.`,
      };
    }
    return { selected: positions };
  }

  if (occurrence === 'first') return { selected: [positions[0]!] };
  if (occurrence === 'last') return { selected: [positions[positions.length - 1]!] };
  if (occurrence === 'all') return { selected: positions };
  const n = occurrence as number;
  if (n < 1 || n > positions.length) {
    return { error: `Occurrence ${n} out of range: file has ${positions.length} match(es)`, status: 'not_found' };
  }
  return { selected: [positions[n - 1]!] };
}

/** @deprecated Synchronous compatibility; production regex edits use applyReplacementsAsync. */
export function applyReplacements(
  content: string,
  selections: { start: number; end: number }[],
  find: string,
  replace: string,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  multiline: boolean = false,
): string {
  const sorted = [...selections].sort((a, b) => b.start - a.start);
  let result = content;
  for (const { start, end } of sorted) {
    let replacement = replace;
    if (mode === 'regex') {
      // Re-run from the match start over the whole content, with the search's own flags,
      // so lookaround, \b and the s/m flags see the same text the search saw.
      const re = compileSafeRegExp(find, regexSearchFlags(caseSensitive, multiline), { operation: 'edit regex replacement' });
      re.lastIndex = start;
      const m = safeRegExpExec(re, content, { operation: 'edit regex replacement' });
      if (!m || m.index !== start || m.index + m[0].length !== end) {
        throw new RegexRecaptureError('The pattern did not match again at a selected position, so its capture groups cannot be read. Nothing was changed.');
      }
      replacement = substituteCaptures(replace, m);
    }
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

async function findAllPositionsAsync(
  content: string, find: string, mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean, whitespaceSensitive: boolean, multiline: boolean, options: JudgmentReadingOptions,
): Promise<{ start: number; end: number }[]> {
  if (mode !== 'regex') return findAllPositions(content, find, mode, caseSensitive, whitespaceSensitive, multiline);
  await assertCapturedToolAccessCurrent();
  await using pattern = await createSafeRegex(find, regexSearchFlags(caseSensitive, multiline), { ...options, operation: 'edit regex search' });
  const positions = await pattern.positions(content);
  await assertCapturedToolAccessCurrent();
  pattern.assertCurrent();
  return [...positions];
}

async function applyReplacementsAsync(
  content: string, selections: { start: number; end: number }[], find: string, replace: string,
  mode: 'exact' | 'fuzzy' | 'regex', caseSensitive: boolean, multiline: boolean, options: JudgmentReadingOptions,
): Promise<string> {
  if (mode !== 'regex') return applyReplacements(content, selections, find, replace, mode, caseSensitive);
  await assertCapturedToolAccessCurrent();
  await using pattern = await createSafeRegex(find, regexSearchFlags(caseSensitive, multiline), { ...options, operation: 'edit regex replacement' });
  let result = content;
  for (const { start, end } of [...selections].sort((a, b) => b.start - a.start)) {
    // Read the captures from the whole content at the match start, with the
    // search's own flags: re-matching the slice alone loses the s/m flags and
    // any lookaround or \b context outside it.
    const match = await pattern.exec(content, start);
    if (!match || match.index !== start || match.index + (match.captures[0]?.length ?? 0) !== end) {
      throw new RegexRecaptureError('The pattern did not match again at a selected position, so its capture groups cannot be read. Nothing was changed.');
    }
    // Preserve the edit API's historical numeric-capture substitution (not
    // String.replace's full replacement language, used by find preview).
    result = result.slice(0, start) + substituteCaptures(replace, match.captures) + result.slice(end);
  }
  await assertCapturedToolAccessCurrent();
  pattern.assertCurrent();
  return result;
}

type AstGrepNode = {
  text(): string;
  range(): {
    start: { line: number; column: number; index: number };
    end: { line: number; column: number; index: number };
  };
  getMatch(name: string): AstGrepNode | null;
  getMultipleMatches(name: string): AstGrepNode[];
};
type AstGrepParser = { parse: (src: string) => { root(): { findAll(pat: string): AstGrepNode[] } } };

let astGrepModulePromise: Promise<AstGrepModule> | null = null;

async function loadAstGrep(): Promise<AstGrepModule> {
  astGrepModulePromise ??= import('@ast-grep/napi');
  return astGrepModulePromise;
}

function getAstGrepLang(astGrep: AstGrepModule, filePath: string): AstGrepParser | null {
  const lang = extname(filePath).slice(1).toLowerCase();
  switch (lang) {
    case 'ts':
      return astGrep.ts as unknown as AstGrepParser;
    case 'tsx':
      return astGrep.tsx as unknown as AstGrepParser;
    case 'js':
    case 'mjs':
    case 'cjs':
      return astGrep.js as unknown as AstGrepParser;
    case 'jsx':
      return astGrep.jsx as unknown as AstGrepParser;
    case 'css':
      return astGrep.css as unknown as AstGrepParser;
    case 'html':
      return astGrep.html as unknown as AstGrepParser;
    default:
      return null;
  }
}

export function computeExactEdit(
  fileContent: string,
  item: EditItem,
): { newContent: string; occurrencesReplaced: number } | EditFailure {
  const text = resolveEditText(item);
  if ('error' in text) return inputFailure(text);
  const { find: findStr, replace: replaceStr } = text;

  let positions = findAllPositions(fileContent, findStr, 'exact', true, true);
  if (positions.length === 0) {
    return { error: `No match found for '${findStr}'`, status: 'not_found' };
  }

  if (item.hints) {
    const scoped = applyHints(fileContent, positions, item.hints, item.hints.near_line);
    if (scoped.positions.length === 0) {
      return { error: `Find string not found within the requested hints (${positions.length} match(es) lie outside them). ${scoped.warning ?? 'Loosen or remove the hints (in_function, in_class, after, before), or read the file to choose the right scope.'}`, status: 'not_found' };
    }
    positions = scoped.positions;
  }

  const selResult = selectOccurrences(positions, item.occurrence);
  if ('error' in selResult) return selResult;

  const newContent = applyReplacements(fileContent, selResult.selected, findStr, replaceStr, 'exact', true);
  return { newContent, occurrencesReplaced: selResult.selected.length };
}

export function computeAstEdit(fileContent: string, item: EditItem, filePath: string): Promise<EditComputationResult> {
  const text = resolveEditText(item);
  if ('error' in text) return Promise.resolve(inputFailure(text));
  const { find: findStr, replace: replaceStr } = text;
  // The workspace's facade: its language files decide which files have a grammar.
  const intel = CodeIntelligence.forPath(filePath);
  return intel
    .getSymbols(filePath, fileContent)
    .then((symbols): EditComputationResult => {
      // Asked after the parse, when the workspace's language files are loaded.
      if (symbols.length === 0 && !intel.hasTreeSitter(filePath)) {
        return withExactFallbackWarning(
          computeExactEdit(fileContent, item),
          `AST match unavailable: no grammar is installed for ${extname(filePath) || 'this file type'}; used exact match instead.`,
        );
      }
      const normalizedFind = findStr.replace(/\s+/g, ' ').trim();
      const positions: { start: number; end: number }[] = [];
      const lines = fileContent.split('\n');

      for (const symbol of symbols) {
        const sig = (symbol.signature ?? symbol.name ?? '').replace(/\s+/g, ' ').trim();
        if (sig.includes(normalizedFind) || normalizedFind.includes(sig)) {
          let lineOffset = 0;
          for (let i = 0; i < symbol.line - 1 && i < lines.length; i++) {
            lineOffset += (lines[i]?.length ?? 0) + 1;
          }
          const lineText = lines[symbol.line - 1] ?? '';
          const col = lineText.indexOf(findStr);
          if (col >= 0) {
            positions.push({ start: lineOffset + col, end: lineOffset + col + findStr.length });
          }
        }
      }

      if (positions.length === 0) {
        return withExactFallbackWarning(
          computeExactEdit(fileContent, item),
          'AST match found no symbols; used exact match instead.',
        );
      }

      if (item.hints) {
        const scoped = applyHints(fileContent, positions, item.hints, item.hints.near_line);
        if (scoped.positions.length === 0) {
          return { error: `Find string not found within the requested hints (${positions.length} match(es) lie outside them). ${scoped.warning ?? 'Loosen or remove the hints (in_function, in_class, after, before), or read the file to choose the right scope.'}`, status: 'not_found' };
        }
        positions.splice(0, positions.length, ...scoped.positions);
      }

      const selResult = selectOccurrences(positions, item.occurrence);
      if ('error' in selResult) return selResult;

      const newContent = applyReplacements(fileContent, selResult.selected, findStr, replaceStr, 'exact', true);
      return { newContent, occurrencesReplaced: selResult.selected.length };
    })
    .catch((err) =>
      withExactFallbackWarning(
        computeExactEdit(fileContent, item),
        `AST match failed (${summarizeError(err)}); used exact match instead.`,
      ),
    );
}

export async function computeAstPatternEdit(
  fileContent: string,
  item: EditItem,
  filePath: string,
): Promise<EditComputationResult> {
  const text = resolveEditText(item);
  if ('error' in text) return inputFailure(text);
  const { find: findStr, replace: replaceStr } = text;

  let astGrep: AstGrepModule;
  try {
    astGrep = await loadAstGrep();
  } catch (err) {
    return withExactFallbackWarning(
      computeExactEdit(fileContent, item),
      `ast_pattern unavailable (${summarizeError(err)}); used exact match instead.`,
    );
  }

  const parser = getAstGrepLang(astGrep, filePath);
  if (!parser) {
    return withExactFallbackWarning(
      computeExactEdit(fileContent, item),
      'ast_pattern unavailable for this file type; used exact match instead.',
    );
  }

  let root: ReturnType<AstGrepParser['parse']>;
  try {
    root = parser.parse(fileContent);
  } catch (e) {
    logger.debug('AST pattern parse failed', { error: summarizeError(e) });
    return withExactFallbackWarning(
      computeExactEdit(fileContent, item),
      `ast_pattern parse failed (${summarizeError(e)}); used exact match instead.`,
    );
  }

  let matches: AstGrepNode[];
  try {
    matches = root.root().findAll(findStr);
  } catch (err) {
    return { error: `ast_pattern: invalid pattern '${findStr}': ${summarizeError(err)}`, status: 'failed' };
  }

  if (matches.length === 0) {
    return { error: `ast_pattern: no matches found for pattern '${findStr}'`, status: 'not_found' };
  }

  let positions = matches.map((m) => ({
    start: m.range().start.index,
    end: m.range().end.index,
    text: m.text(),
    node: m,
  }));
  if (item.hints) {
    const scoped = applyHints(fileContent, positions, item.hints, item.hints.near_line);
    const kept = new Set(scoped.positions);
    const inside = positions.filter((pos) => kept.has(pos));
    if (inside.length === 0) {
      return { error: `ast_pattern: no match lies within the requested hints (${positions.length} match(es) lie outside them). ${scoped.warning ?? 'Loosen or remove the hints (in_function, in_class, after, before), or read the file to choose the right scope.'}`, status: 'not_found' };
    }
    positions = inside;
  }
  const occSpec = item.occurrence;
  let selected: typeof positions;
  if (occSpec === undefined) {
    if (positions.length > 1) {
      return {
        error: `ast_pattern: ${positions.length} matches found, set occurrence to 'first', 'last', 'all', or N to disambiguate`,
        status: 'ambiguous',
      };
    }
    selected = positions;
  } else if (occSpec === 'all') {
    selected = positions;
  } else if (occSpec === 'first') {
    selected = positions.slice(0, 1);
  } else if (occSpec === 'last') {
    selected = positions.slice(-1);
  } else if (typeof occSpec === 'number') {
    if (occSpec < 1 || occSpec > positions.length) {
      return { error: `ast_pattern: occurrence ${occSpec} out of range (found ${positions.length} matches)`, status: 'not_found' };
    }
    selected = [positions[occSpec - 1]!];
  } else {
    selected = positions;
  }

  // A match nested inside another selected match is part of the outer one: its
  // text is rewritten with the outer replacement, and splicing both by original
  // offsets would eat or leave characters. Keep the outermost matches only.
  const outermost = selected.filter((pos) => !selected.some((other) => other !== pos
    && other.start <= pos.start && pos.end <= other.end && (other.start < pos.start || pos.end < other.end)));
  const sorted = [...outermost].sort((a, b) => b.start - a.start);
  let newContent = fileContent;
  for (const pos of sorted) {
    let replacement = replaceStr;
    replacement = replacement.replace(/\$\$\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const nodes = pos.node.getMultipleMatches(varName);
      return nodes.map((n) => n.text()).join(', ');
    });
    replacement = replacement.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const node = pos.node.getMatch(varName);
      return node ? node.text() : _;
    });
    newContent = newContent.slice(0, pos.start) + replacement + newContent.slice(pos.end);
  }

  const collapsed = selected.length - outermost.length;
  return {
    newContent,
    occurrencesReplaced: outermost.length,
    ...(collapsed > 0 ? { warning: `${collapsed} match(es) nested inside another selected match were replaced as part of it.` } : {}),
  };
}

/**
 * Classify a successful edit's warning string into which lenient fallback the
 * matcher used to land it, or null for a warning that is not a fallback notice.
 * Co-located with the warning phrases produced by computeSingleEdit (see
 * `usedFallback` above) so the classifier and the strings it reads stay in one
 * file. Used by tool-format telemetry to count fallback-mode edits per model.
 */
export function classifyEditFallbackWarning(warning: string): 'whitespace' | 'fuzzy-lines' | null {
  if (warning.includes('whitespace-normalized match')) return 'whitespace';
  if (warning.includes('fuzzy line match')) return 'fuzzy-lines';
  return null;
}

export function buildFailedEditResult(item: EditItem, error: string, status: EditResultStatus): EditResult {
  return {
    id: item.id,
    path: item.path,
    success: false,
    status,
    error,
  };
}

/** A run of file lines, as long as the find text, ranked by how closely it matches it. */
interface NearWindow {
  readonly startLine: number;
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
  readonly score: number;
}

/** Windows shown with a not-found result. */
const NEAR_WINDOWS_SHOWN = 3;
/** Line starts kept after the first-line ranking for a full window score. */
const NEAR_WINDOW_ANCHORS = 48;
/** Below this similarity a window is not shown as close text: it shares too little to help. */
const NEAR_WINDOW_SHOW_SCORE = 0.3;

function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2));
  return grams;
}

/** Dice similarity of two lines' character pairs, ignoring whitespace runs: 1 for equal text, 0 for nothing shared. */
function lineSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * The windows of the file closest to the find text, best first, decided in
 * code: each line start is ranked by its first line, the best few are scored
 * over every line of the window. Cost follows the file's length once plus a
 * fixed number of full window scores.
 */
export function nearestWindows(file: string, find: string, count = NEAR_WINDOWS_SHOWN): NearWindow[] {
  const lines = file.split('\n');
  const findLines = find.replace(/\n$/, '').split('\n');
  const size = findLines.length;
  if (lines.length < size) return [];
  const findGrams = findLines.map(bigrams);
  const fileGrams = lines.map(bigrams);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const anchors = Array.from({ length: lines.length - size + 1 }, (_, start) => ({ start, first: lineSimilarity(findGrams[0]!, fileGrams[start]!) }))
    .sort((a, b) => b.first - a.first)
    .slice(0, NEAR_WINDOW_ANCHORS);
  return anchors
    .map(({ start }) => {
      let total = 0;
      for (let i = 0; i < size; i++) total += lineSimilarity(findGrams[i]!, fileGrams[start + i]!);
      const windowLines = lines.slice(start, start + size);
      const begin = offsets[start]!;
      return { startLine: start + 1, start: begin, end: begin + windowLines.join('\n').length, lines: windowLines, score: total / size };
    })
    .sort((a, b) => b.score - a.score || a.startLine - b.startLine)
    .slice(0, count);
}

/** The closest text, for a not-found answer: line numbers and lines the caller can copy into find. */
function describeNearWindows(windows: readonly NearWindow[]): string {
  return windows
    .map((window) => `line ${window.startLine} (${Math.round(window.score * 100)}% alike):\n${window.lines.map((line) => `  ${line}`).join('\n')}`)
    .join('\n');
}

function notFoundAnswer(windows: readonly NearWindow[], hintsWarning: string | undefined): EditFailure {
  const nearest = windows.filter((window) => window.score >= NEAR_WINDOW_SHOW_SCORE);
  return {
    status: 'not_found',
    error: nearest.length > 0
      ? `Find string not found in file. Closest text:\n${describeNearWindows(nearest)}`
      : 'Find string not found in file',
    hint: hintsWarning ?? 'Copy the exact text from the file into find (read the lines above), or pass match.mode "fuzzy" to let the closest near-match be applied after a check.',
  };
}

/**
 * The near-match fuzzy mode may apply: the closest window when it is the one
 * best window and Jev reads it as the code the find text was copied from
 * (`engine.tools.edit-target`, one request within the decision deadline); no
 * similarity cutoff decides. Two windows tied for best stay ambiguous. An
 * unsure, late or unavailable reading applies nothing.
 */
async function confirmNearWindow(find: string, windows: readonly NearWindow[], options: JudgmentReadingOptions): Promise<NearWindow | null> {
  const [best, second] = windows;
  // A window not close enough to show is not close enough to ask about: the edit fails at once with the hint.
  if (!best || best.score < NEAR_WINDOW_SHOW_SCORE || (second !== undefined && second.score >= best.score)) return null;
  let state: ReturnType<typeof editTargetView>;
  try { state = editTargetView(find, best.lines); } catch { return null; }
  const { value } = await judge({
    site: EDIT_TARGET_SITE,
    battery: editTarget,
    state,
    settle: ({ same_target: reading }) => reading.outcome === 'act' && reading.verdict !== 'uncertain' ? reading.verdict === 'yes' : undefined,
    fallback: () => false,
    describe: (same) => same ? 'Apply the closest window.' : 'Hold the closest window.',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return value ? best : null;
}

export async function computeSingleEdit(
  fileContent: string,
  item: EditItem,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  whitespaceSensitive: boolean = true,
  multiline: boolean = false,
  options: JudgmentReadingOptions = {},
): Promise<
  | { newContent: string; occurrencesReplaced: number; warning?: string | undefined }
  | EditFailure
> {
  // The item is this call's own argument; the signal and the caller's check say whether the call is still wanted.
  const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  current();
  const readingOptions = { ...options, assertCurrent: current };
  const text = resolveEditText(item);
  if ('error' in text) return inputFailure(text);
  const { find: findStr, replace: replaceStr } = text;

  let positions: { start: number; end: number }[];
  try {
    positions = await findAllPositionsAsync(fileContent, findStr, mode, caseSensitive, whitespaceSensitive, multiline, readingOptions);
  } catch (err) {
    return { error: `Invalid find pattern: ${summarizeError(err)}`, status: 'failed' };
  }

  const matchesBeforeHints = positions.length;
  let hintsWarning: string | undefined;
  if (item.hints) {
    const hintsResult = applyHints(fileContent, positions, item.hints, item.hints.near_line);
    positions = hintsResult.positions;
    hintsWarning = hintsResult.warning;
  }

  // The lenient searches below run only when the exact search itself found
  // nothing. When hints removed every match, the text exists but not where the
  // caller asked for it; searching the whole file again would edit elsewhere.
  if (positions.length === 0 && matchesBeforeHints > 0) {
    return {
      error: `Find string not found within the requested hints (${matchesBeforeHints} match(es) lie outside them)`,
      status: 'not_found',
      hint: hintsWarning ?? 'Loosen or remove the hints (in_function, in_class, after, before), or read the file to choose the right scope.',
    };
  }

  let usedFallback: 'whitespace' | 'fuzzy-lines' | null = null;
  if (positions.length === 0 && (mode === 'exact' || mode === 'fuzzy')) {
    let fallback: { start: number; end: number }[] = mode === 'exact' ? findAllPositions(fileContent, findStr, 'fuzzy', caseSensitive, true) : [];
    if (fallback.length > 0) usedFallback = 'whitespace';
    else {
      // Not in the file: answer from code with the closest text. Only fuzzy mode may apply a near match.
      const windows = nearestWindows(fileContent, findStr);
      const near = mode === 'fuzzy' ? await confirmNearWindow(findStr, windows, options) : null;
      current(); await assertCapturedToolAccessCurrent();
      if (near) {
        fallback = [{ start: near.start, end: near.end }];
        usedFallback = 'fuzzy-lines';
        logger.warn('[edit] Fuzzy line match used', { score: near.score, file: item.path });
      } else if (!item.hints) {
        return notFoundAnswer(windows, hintsWarning);
      }
    }
    // The fallbacks search the whole file; hints still bind what they find.
    if (fallback.length > 0 && item.hints) {
      const scoped = applyHints(fileContent, fallback, item.hints, item.hints.near_line);
      fallback = scoped.positions;
      hintsWarning = scoped.warning ?? hintsWarning;
    }
    if (fallback.length === 0) {
      return item.hints && usedFallback
        ? { error: 'Find string not found within the requested hints', status: 'not_found', hint: hintsWarning ?? 'The closest match lies outside the hints; loosen them or read the file.' }
        : { error: 'Find string not found in file', status: 'not_found', hint: hintsWarning ?? 'Read the file and provide the exact replacement target.' };
    }
    positions = fallback;
  }

  const selResult = selectOccurrences(positions, item.occurrence);
  if ('error' in selResult) return hintsWarning ? { ...selResult, hint: selResult.hint ?? hintsWarning } : selResult;

  let newContent: string;
  try {
    newContent = await applyReplacementsAsync(fileContent, selResult.selected, findStr, replaceStr, mode, caseSensitive, multiline, readingOptions);
  } catch (err) {
    if (err instanceof RegexRecaptureError) return { error: err.message, status: 'failed' };
    throw err;
  }

  const warnings: string[] = [];
  if (hintsWarning) warnings.push(hintsWarning);
  if (usedFallback === 'whitespace') {
    warnings.push('Exact match failed; used whitespace-normalized match instead.');
  } else if (usedFallback === 'fuzzy-lines') {
    warnings.push('Exact match failed; used fuzzy line match (content may differ slightly, verify the edit).');
  }

  return { newContent, occurrencesReplaced: selResult.selected.length, warning: warnings.length > 0 ? warnings.join(' ') : undefined };
}
