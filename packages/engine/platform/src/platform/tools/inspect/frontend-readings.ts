/**
 * The frontend analyzers whose findings are read by Jev
 * (`engine.tools.frontend-finding`, tools/batteries/frontend-finding.ts).
 * Code finds each candidate from syntax (an element start, a hook call, an
 * overflow or fixed-size utility, an import specifier, a z-index value set on
 * more than one line); one request per file reads all of them
 * (inspect/candidate-readings.ts). A candidate is reported unless the reading
 * is a no, so an uncertain one is shown with `reading: 'uncertain'`, and one
 * no reading assessed (decision models off, a failed request) with
 * `reading: 'unassessed'` or, where the report has no such value, as
 * uncertain with the result's `assessment_note` saying why.
 */
import { judgeSome } from '../../runtime/judge.js';
import {
  frontendFinding,
  frontendLineView,
  hookCode,
  stackingView,
} from '../batteries/frontend-finding.js';
import { readFileCandidates, type CandidateReading, type InspectCandidate } from './candidate-readings.js';
import type {
  A11yIssue,
  ClientBoundaryInfo,
  HookDep,
  HooksInfo,
  OverflowInfo,
  OverflowIssue,
  SizingInfo,
  SizingItem,
  StackingConflict,
  StackingInfo,
  ZIndexItem,
} from './schema.js';

const SITE = 'tools.inspect.frontend-finding';

type Question =
  | 'a11y_violation'
  | 'omits_dependency'
  | 'overflow_problem'
  | 'fixed_size_problem'
  | 'stacking_conflict';
export type FindingReading = 'real' | 'uncertain' | 'unassessed';

/** What an analyzer reports beside its findings when some candidates were not assessed. */
export type AssessmentNote = { assessment_note?: string };

/** Reads one question for every candidate of a file, in one request. */
async function readAll(question: Question, file: string, candidates: readonly InspectCandidate[], signal?: AbortSignal): Promise<{ readings: Map<string, CandidateReading>; note: AssessmentNote }> {
  const { readings, note } = await readFileCandidates({ site: SITE, battery: frontendFinding, question, file, candidates, signal });
  return { readings, note: note === undefined ? {} : { assessment_note: note } };
}

// ── Accessibility ─────────────────────────────────────────────────────────────

/** The WCAG rule each element kind is read against. */
const A11Y_RULES = {
  'img-alt': {
    rule: 'img-alt: images need an alt attribute',
    message: 'img element is missing an alt attribute',
    wcag: 'WCAG 1.1.1 (Level A)',
  },
  'button-name': {
    rule: 'button-name: buttons need an accessible name',
    message: 'button element is missing an accessible name',
    wcag: 'WCAG 4.1.2 (Level A)',
  },
  'click-events-have-key-events': {
    rule: 'click-events-have-key-events: clickable non-interactive elements need a role and keyboard handling',
    message: 'Non-interactive element has onClick without a role or keyboard handling',
    wcag: 'WCAG 4.1.2 (Level A)',
  },
  label: {
    rule: 'label: form fields need a label',
    message: 'input element is missing an associated label',
    wcag: 'WCAG 1.3.1 (Level A)',
  },
} as const;
type A11yCode = keyof typeof A11Y_RULES;

/** Lines an element may span before its opening tag closes. */

function openingTag(lines: readonly string[], index: number): string {
  const parts: string[] = [];
  for (let j = index; j < lines.length; j++) {
    parts.push(lines[j]!);
    if (lines[j]!.includes('>')) break;
  }
  return parts.join(' ');
}

/** Which rule an element starting on this line is read against, from its tag (syntax only). */
function a11yCandidate(lines: readonly string[], index: number): A11yCode | null {
  const line = lines[index]!;
  if (/<img\b/i.test(line)) return 'img-alt';
  if (/<button\b/i.test(line)) return 'button-name';
  if (/<input\b/i.test(line)) {
    // A hidden input is not shown, so it takes no label (HTML).
    return /type=['"]hidden['"]/.test(openingTag(lines, index)) ? null : 'label';
  }
  if (/<(?:div|span)\b/i.test(line) && /\bonClick\b/.test(openingTag(lines, index)))
    return 'click-events-have-key-events';
  return null;
}

export async function inspectAccessibility(
  content: string,
  file = '',
  signal?: AbortSignal,
): Promise<{ issues: Array<A11yIssue & { reading: FindingReading }> } & AssessmentNote> {
  const lines = content.split('\n');
  const candidates = lines.flatMap((_, index) => {
    const code = a11yCandidate(lines, index);
    return code === null ? [] : [{ index, code }];
  });
  const { readings, note } = await readAll('a11y_violation', file,
    candidates.map(({ index, code }) => ({ id: `L${index + 1}`, view: frontendLineView(file, lines, index, { rule: A11Y_RULES[code].rule }) })), signal);
  const issues = candidates.flatMap(({ index, code }) => {
    const reading = readings.get(`L${index + 1}`)!;
    if (reading === 'dismissed') return [];
    const { message, wcag } = A11Y_RULES[code];
    return [{ line: index + 1, code, message, wcag, reading }];
  });
  return { issues, ...note };
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** The hook call starting at `index`, up to its closing parenthesis (bounded). */
function hookCall(lines: readonly string[], index: number, start: number): string {
  let depth = 0;
  const parts: string[] = [];
  for (let j = index; j < lines.length; j++) {
    const text = j === index ? lines[j]!.slice(start) : lines[j]!;
    parts.push(j === index ? lines[j]! : text);
    for (const ch of text) {
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return parts.join('\n');
    }
  }
  return parts.join('\n');
}

export async function inspectHooks(content: string, file: string, signal?: AbortSignal): Promise<HooksInfo & AssessmentNote> {
  const lines = content.split('\n');
  const hookRe = /\b(useEffect|useMemo|useCallback)\s*\(/;
  const calls = lines.flatMap((line, index) => {
    const m = hookRe.exec(line);
    return m ? [{ index, kind: m[1] as HookDep['hookKind'], code: hookCall(lines, index, m.index) }] : [];
  });
  const { readings, note } = await readAll('omits_dependency', file,
    calls.map(({ code, index }) => ({ id: `L${index + 1}`, view: { file, code: hookCode(code) } })), signal);
  const hooks: HookDep[] = calls.map(({ index, kind, code }) => {
    // The dependency array is the last array literal before the call closes (syntax).
    const deps =
      /\[([^\]]*)\]\s*\)\s*;?\s*$/
        .exec(code)?.[1]
        ?.split(',')
        .map((dep) => dep.trim())
        .filter(Boolean) ?? [];
    const reading = readings.get(`L${index + 1}`)!;
    return {
      hookKind: kind,
      line: index + 1,
      deps,
      omitsDependency: reading === 'dismissed' ? 'no' : reading === 'real' ? 'yes' : 'uncertain',
    };
  });
  return { file, hooks, missingDepsCount: hooks.filter((hook) => hook.omitsDependency === 'yes').length, ...note };
}

// ── Overflow ──────────────────────────────────────────────────────────────────

export async function inspectOverflow(content: string, file: string, signal?: AbortSignal): Promise<OverflowInfo & AssessmentNote> {
  const lines = content.split('\n');
  const candidates = lines.flatMap((line, index): Array<{ index: number; kind: OverflowIssue['kind'] }> => {
    if (/\boverflow-hidden\b/.test(line) || /overflow\s*:\s*hidden/.test(line)) return [{ index, kind: 'hidden_clip' }];
    if (/\boverflow-(?:x-|y-)?(?:scroll|auto)\b/.test(line) || /overflow(?:-y|-x)?\s*:\s*(?:scroll|auto)/.test(line))
      return [{ index, kind: 'scroll_no_height' }];
    return [];
  });
  const { readings, note } = await readAll('overflow_problem', file,
    candidates.map(({ index }) => ({ id: `L${index + 1}`, view: frontendLineView(file, lines, index) })), signal);
  const issues: Array<OverflowIssue & { reading: FindingReading }> = candidates.flatMap(({ index, kind }) => {
    const reading = readings.get(`L${index + 1}`)!;
    return reading === 'dismissed'
      ? []
      : [{ line: index + 1, kind, snippet: lines[index]!.trim().slice(0, 80), reading }];
  });
  return { file, issues, count: issues.length, ...note };
}

// ── Sizing ────────────────────────────────────────────────────────────────────

export async function inspectSizing(content: string, file: string, signal?: AbortSignal): Promise<SizingInfo & AssessmentNote> {
  const lines = content.split('\n');
  const items: SizingItem[] = [];
  const patterns: ReadonlyArray<readonly [RegExp, SizingItem['kind']]> = [
    [/\b(?:w|h|min-w|max-w|min-h|max-h)-(?:\d+|\[\d+(?:px|rem)\])(?=[\s"'`]|$)/g, 'fixed_px'],
    [/\b(?:w|h)-(?:\d+\/\d+|full|screen)\b/g, 'percentage'],
    [/\bflex-(?:1|auto|none|initial|grow|shrink)\b/g, 'flex'],
    [/\bgrid-cols-\d+\b/g, 'grid'],
    [/\b(?:w|h)-(?:screen|lvh|svh|dvh)\b/g, 'viewport'],
    [/(?:width|height|min-width|max-width|min-height|max-height)\s*:\s*\d+px/g, 'fixed_px'],
    [/(?:width|height)\s*:\s*\d+%/g, 'percentage'],
  ];
  lines.forEach((line, index) => {
    for (const [re, kind] of patterns) {
      for (const m of line.matchAll(re)) items.push({ line: index + 1, kind, value: m[0], flagged: false });
    }
  });
  // Each line holding a fixed size is read once; its fixed items are flagged unless the reading is a no.
  const fixedLines = [...new Set(items.filter((item) => item.kind === 'fixed_px').map((item) => item.line))];
  const { readings, note } = await readAll('fixed_size_problem', file,
    fixedLines.map((line) => ({ id: `L${line}`, view: frontendLineView(file, lines, line - 1) })), signal);
  const flaggedLines = new Set(fixedLines.filter((line) => readings.get(`L${line}`) !== 'dismissed'));
  for (const item of items) item.flagged = item.kind === 'fixed_px' && flaggedLines.has(item.line);
  return { file, items, hardcodedCount: items.filter((item) => item.flagged).length, ...note };
}

// ── Stacking ──────────────────────────────────────────────────────────────────

/**
 * The z-index a matched value sets: Tailwind's z-N utility sets N and -z-N
 * sets -N (Tailwind's scale), and a CSS declaration sets its number, so z-50
 * and `z-index: 50` are the same value.
 */
function zIndexOf(match: string): string {
  const css = /z-index\s*:\s*(-?\d+)/.exec(match);
  if (css) return css[1]!;
  const utility = /^(-?)z-(\d+|auto)$/.exec(match)!;
  return utility[2] === 'auto' ? 'auto' : `${utility[1]}${utility[2]}`;
}

/**
 * Every z-index utility and declaration in the file is listed (syntax). Each
 * value set on more than one line is read by `stacking_conflict` with every
 * line that sets it; it is a conflict unless the reading is a no.
 */
export async function inspectStacking(content: string, file: string, signal?: AbortSignal): Promise<StackingInfo & AssessmentNote> {
  const lines = content.split('\n');
  const zIndexItems: ZIndexItem[] = [];
  lines.forEach((line, index) => {
    for (const m of line.matchAll(/-?z-(?:\d+|auto)\b/g))
      zIndexItems.push({ line: index + 1, value: m[0], context: line.trim().slice(0, 60) });
    for (const m of line.matchAll(/z-index\s*:\s*-?\d+/g))
      zIndexItems.push({ line: index + 1, value: m[0], context: line.trim().slice(0, 60) });
  });
  const byIndex = new Map<string, { values: Set<string>; lines: Set<number> }>();
  for (const item of zIndexItems) {
    const group = byIndex.get(zIndexOf(item.value)) ?? { values: new Set(), lines: new Set() };
    group.values.add(item.value);
    group.lines.add(item.line);
    byIndex.set(zIndexOf(item.value), group);
  }
  const shared = [...byIndex.values()]
    .filter((group) => group.lines.size > 1)
    .map((group) => ({ values: [...group.values], lines: [...group.lines] }));
  const { readings, note } = await readAll('stacking_conflict', file,
    shared.map(({ values, lines: lineNumbers }, i) => ({ id: `Z${i + 1}`, view: stackingView(file, lines, values.join(' / '), lineNumbers) })), signal);
  const potentialConflicts: StackingConflict[] = shared.flatMap((group, i) => {
    const reading = readings.get(`Z${i + 1}`)!;
    return reading === 'dismissed' ? [] : [{ ...group, reading: reading === 'real' ? 'real' as const : 'uncertain' as const }];
  });
  return { file, zIndexItems, potentialConflicts, ...note };
}

// ── Client boundary ───────────────────────────────────────────────────────────

/**
 * Whether a module can only run on the server, read by its specifier alone and kept for the process
 * (a module's nature does not change); an unsure, late or unavailable reading lists it as uncertain.
 */
async function readServerOnly(module: string, signal?: AbortSignal): Promise<CandidateReading> {
  const { value } = await judgeSome<typeof frontendFinding.items, CandidateReading>({
    site: SITE,
    battery: frontendFinding,
    only: ['server_only'],
    state: { module },
    cache: { key: module, scope: 'process' },
    // An absent reading is unsure: the module is listed as uncertain.
    settle: ({ server_only: reading }) => reading === undefined ? undefined : reading.verdict === 'yes' ? 'real' : reading.verdict === 'no' ? 'dismissed' : undefined,
    fallback: (why) => why === 'off' ? 'unassessed' : 'uncertain',
    describe: (reading) => `server_only: ${reading}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return value;
}

/**
 * The file's directive is its first statement, after any comments (React's
 * rule); its imports are listed from syntax and each module is read for
 * whether it can only run on the server.
 */
export async function inspectClientBoundary(content: string, file: string, signal?: AbortSignal): Promise<ClientBoundaryInfo & AssessmentNote> {
  const code = content.replace(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*/, '');
  const directive = /^(['"])use (client|server)\1\s*;?/.exec(code);
  const modules = [
    ...new Set([...content.matchAll(/import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]!)),
  ];
  const readings = await Promise.all(modules.map((module) => readServerOnly(module, signal)));
  const serverOnlyImports = modules.filter((_, i) => readings[i] !== 'dismissed');
  const unassessed = readings.filter((reading) => reading === 'unassessed').length;
  return {
    file,
    directive: directive ? (`use ${directive[2]}` as ClientBoundaryInfo['directive']) : null,
    importsServerOnly: serverOnlyImports.length > 0,
    serverOnlyImports,
    ...(unassessed > 0 ? { assessment_note: `Decision models are off, so ${unassessed} imports are listed as possibly server-only, unassessed.` } : {}),
  };
}
