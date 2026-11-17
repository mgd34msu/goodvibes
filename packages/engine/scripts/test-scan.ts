/**
 * The admission scan the test runner applies to every selected file before any
 * file starts. A file that waits on a clock, compares against a snapshot,
 * replaces a module, skips a test, or raises its own time limit is refused, and
 * so is the whole run. So is a file without its header, or with a case, a risk
 * or a row the risk table and the file do not agree on.
 *
 * Each file is parsed with the TypeScript parser and the forms are matched on
 * the syntax tree, so text inside a string, a template, a comment or a regular
 * expression never matches, and a method of the same name on an unrelated
 * object (`cursor.skip(2)`, `queue.todo(...)`) is not mistaken for a test
 * modifier: only calls rooted at the test API (`test`, `it`, `describe`, the
 * hooks, `mock`, or the local names a file gave them when importing from
 * `bun:test`) count.
 *
 * The header is the run of `//` lines that opens the file (after a `#!` line):
 * for each risk the file proves, `// Proves: <the risk>` then
 * `// Red when: <the breakage that turns it red>`, each of at least six words.
 * The record is packages/engine/docs/test-risks.md, one row per case: a file's
 * `Proves` sentences are the risks of its rows, every case has a row, and every
 * row names a case its file has.
 *
 *   bun packages/engine/scripts/test-scan.ts             the test files the runner does not start (the web UI's
 *                                                        Playwright journeys), and every row of the record names a file
 *   bun packages/engine/scripts/test-scan.ts <file>...   the named files
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface ScanFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** The record of every case and the risk it proves. */
export const RISK_TABLE_PATH = join(REPO_ROOT, 'packages/engine/docs/test-risks.md');
const RISK_TABLE_NAME = relative(REPO_ROOT, RISK_TABLE_PATH).split(sep).join('/');
/** Test files the runner does not start: the web UI's Playwright journeys run under Playwright. */
const OUTSIDE_RUNNER_DIRECTORIES = ['products/webui/e2e'];
const OUTSIDE_RUNNER_FILE = /\.e2e\.ts$/;

const TEST_DEFINERS = new Set(['test', 'it']);
const CHAIN_ROOTS = new Set(['test', 'it', 'describe']);
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const SKIPPING = new Set(['skip', 'todo', 'skipIf', 'todoIf']);
const SKIPPING_ALIASES = new Set(['xit', 'xtest', 'xdescribe']);
// Modifiers that return a test function rather than define a test.
const FACTORIES = new Set(['each', 'if', 'skipIf', 'todoIf']);
const SNAPSHOTS = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot', 'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot']);
const TIMER_PROMISE_MODULES = new Set(['timers/promises', 'node:timers/promises']);

const PROVES = '// Proves: ';
const RED_WHEN = '// Red when: ';
const MIN_HEADER_WORDS = 6;

/** One row of the record: what a case proves and where it is. */
export interface RiskRow {
  readonly line: number;
  readonly risk: string;
  readonly file: string;
  readonly case: string;
}

/** The record read once per run: its rows by proof file, and any row that could not be read. */
export interface RiskTable {
  /** The name findings about a row carry. */
  readonly label: string;
  readonly byFile: ReadonlyMap<string, readonly RiskRow[]>;
  readonly findings: readonly ScanFinding[];
}

/** Read the record. Cells are split on `|` not preceded by a backslash; `\|` is a literal bar. */
export function parseRiskTable(text: string, label: string = RISK_TABLE_NAME): RiskTable {
  const byFile = new Map<string, RiskRow[]>();
  const findings: ScanFinding[] = [];
  let header = true;
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith('|')) return;
    // The column titles and the rule under them.
    if (header) { if (/^\|[\s|:-]+\|$/.test(line)) header = false; return; }
    const cells = line.slice(1, line.endsWith('|') && !line.endsWith('\\|') ? -1 : undefined)
      .split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
    const [, risk, file, title] = cells;
    if (cells.length !== 5 || !risk || !file || !title) {
      findings.push({ file: label, line: index + 1, rule: 'risk table: malformed row (five cells: area, risk, file, case, red when)' });
      return;
    }
    const rows = byFile.get(file) ?? [];
    rows.push({ line: index + 1, risk, file, case: title });
    byFile.set(file, rows);
  });
  return { label, byFile, findings };
}

/** Read the record from disk; a missing record is itself a finding. */
export function readRiskTable(path: string = RISK_TABLE_PATH): RiskTable {
  if (!existsSync(path)) return { label: RISK_TABLE_NAME, byFile: new Map(), findings: [{ file: RISK_TABLE_NAME, line: 1, rule: 'risk table: the record is missing' }] };
  return parseRiskTable(readFileSync(path, 'utf8'));
}

/** A row whose proof file does not exist. Whole-suite runs only: a run of one file says nothing about the others. */
export function missingProofFiles(table: RiskTable, root: string = REPO_ROOT): ScanFinding[] {
  return [...table.byFile.values()].flat()
    .filter((row) => !existsSync(join(root, row.file)))
    .map((row) => ({ file: table.label, line: row.line, rule: `risk table: row names a missing file (${row.file})` }));
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** A case's title as it reads: a string's value, or a template's text with its `${...}` as written. */
function titleOf(source: ts.SourceFile, node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText(source).slice(1, -1);
  return node.getText(source);
}

interface HeaderPair { readonly proves: string; readonly provesLine: number; readonly redWhen: string; readonly redWhenLine: number }

/** The header's pairs, or the findings that refuse it. */
function readHeader(file: string, text: string, source: ts.SourceFile): { pairs: HeaderPair[]; findings: ScanFinding[] } {
  const findings: ScanFinding[] = [];
  const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1;
  const start = ts.getShebang(text)?.length ?? 0;
  // The run of `//` lines that opens the file: single-line comments with only a line break between them.
  const run: { text: string; line: number }[] = [];
  let previousEnd = -1;
  for (const range of ts.getLeadingCommentRanges(text, start) ?? []) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) break;
    const gap = previousEnd < 0 ? text.slice(start, range.pos) : text.slice(previousEnd, range.pos);
    if (previousEnd < 0 ? gap.trim() !== '' : !/^\r?\n$/.test(gap)) break;
    run.push({ text: text.slice(range.pos, range.end), line: lineOf(range.pos) });
    previousEnd = range.end;
  }
  const malformed = (line: number): { pairs: HeaderPair[]; findings: ScanFinding[] } =>
    ({ pairs: [], findings: [{ file, line, rule: `header: missing or malformed (the file opens with ${PROVES.trim()} and ${RED_WHEN.trim()} pairs)` }] });
  if (run.length === 0) return malformed(lineOf(start));
  const pairs: HeaderPair[] = [];
  for (let index = 0; index < run.length; index += 2) {
    const proves = run[index]!, redWhen = run[index + 1];
    if (!proves.text.startsWith(PROVES)) return malformed(proves.line);
    if (redWhen === undefined || !redWhen.text.startsWith(RED_WHEN)) return malformed(redWhen?.line ?? proves.line);
    pairs.push({ proves: proves.text.slice(PROVES.length).trim(), provesLine: proves.line, redWhen: redWhen.text.slice(RED_WHEN.length).trim(), redWhenLine: redWhen.line });
  }
  const seen = new Set<string>();
  for (const pair of pairs) {
    for (const [sentence, line] of [[pair.proves, pair.provesLine], [pair.redWhen, pair.redWhenLine]] as const) {
      if (sentence.split(/\s+/).filter(Boolean).length < MIN_HEADER_WORDS || /(\.\.\.|…)$/.test(sentence)) {
        findings.push({ file, line, rule: `header: empty (at least ${MIN_HEADER_WORDS} words, one finished sentence)` });
      }
    }
    if (pair.redWhen === pair.proves) findings.push({ file, line: pair.redWhenLine, rule: 'header: Red when repeats its Proves' });
    if (seen.has(pair.proves)) findings.push({ file, line: pair.provesLine, rule: 'header: two Proves lines state the same risk' });
    seen.add(pair.proves);
  }
  return { pairs, findings };
}

/** The file's header and cases against its rows in the record. */
function checkRecord(file: string, pairs: readonly HeaderPair[], cases: readonly { title: string; line: number }[], table: RiskTable): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const rows = table.byFile.get(file) ?? [];
  const risks = new Set(rows.map((row) => row.risk));
  const proved = new Set(pairs.map((pair) => pair.proves));
  for (const pair of pairs) if (!risks.has(pair.proves)) findings.push({ file, line: pair.provesLine, rule: 'risk table: Proves line has no row' });
  for (const row of rows) {
    if (!proved.has(row.risk)) findings.push({ file: table.label, line: row.line, rule: `risk table: row's risk is not a Proves line of ${file}` });
  }
  const titles = new Set(cases.map((entry) => entry.title));
  const named = new Set(rows.map((row) => row.case));
  for (const entry of cases) if (!named.has(entry.title)) findings.push({ file, line: entry.line, rule: 'risk table: case has no row' });
  for (const row of rows) {
    if (!titles.has(row.case)) findings.push({ file: table.label, line: row.line, rule: `risk table: row names a case ${file} does not have` });
  }
  return findings;
}

/**
 * Scan one file's text. `file` labels findings and, when `table` is given, is
 * the path from the repository root its rows are found under; without a table
 * only the forms are checked.
 */
export function scanTestSource(file: string, text: string, table?: RiskTable): ScanFinding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const findings: ScanFinding[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node: ts.Node, rule: string): void => {
    findings.push({ file, line: lineOf(node), rule });
  };
  const cases: { title: string; line: number }[] = [];

  // Local names of the test API: `import { test as check } from 'bun:test'` makes `check` mean `test`,
  // `import * as bt from 'bun:test'` makes `bt.test` mean `test`. Without an import the globals keep their names.
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (from === 'bun:test' && bindings) {
      if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else for (const element of bindings.elements) aliases.set(element.name.text, (element.propertyName ?? element.name).text);
    }
    if (TIMER_PROMISE_MODULES.has(from) && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'setTimeout' || imported === 'scheduler') report(element, `${imported} from ${from} (a promise resolved by a timer)`);
      }
    }
  }

  /** The test-API name an expression stands for, or undefined. */
  const apiName = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) return expression.name.text;
    return undefined;
  };

  /** `test.concurrent.each(rows)` → root `test`, modifiers `concurrent`, `each`. */
  const chain = (callee: ts.Expression): { root: string | undefined; modifiers: string[] } => {
    const modifiers: string[] = [];
    let current = callee;
    for (;;) {
      const named = apiName(current);
      if (named !== undefined && (CHAIN_ROOTS.has(named) || HOOKS.has(named) || SKIPPING_ALIASES.has(named))) return { root: named, modifiers };
      if (ts.isPropertyAccessExpression(current)) { modifiers.unshift(current.name.text); current = current.expression; }
      else if (ts.isCallExpression(current)) current = current.expression;
      else return { root: undefined, modifiers };
    }
  };

  /** A call that defines a test: `test(...)`, `it.only(...)`, `test.each(rows)(...)`, `test.if(ok)(...)`. */
  const definesTest = (call: ts.CallExpression): boolean => {
    const { root } = chain(call.expression);
    if (root === undefined || !TEST_DEFINERS.has(root)) return false;
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) return !FACTORIES.has(callee.name.text);
    if (ts.isCallExpression(callee)) return ts.isPropertyAccessExpression(callee.expression) && FACTORIES.has(callee.expression.name.text);
    return true;
  };

  /** True when `name` appears as an identifier anywhere under `node`. */
  const mentions = (node: ts.Node, name: string): boolean => {
    if (ts.isIdentifier(node) && node.text === name) return true;
    return ts.forEachChild(node, (child) => mentions(child, name) || undefined) ?? false;
  };

  const isSetTimeout = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && callee.text === 'setTimeout')
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'setTimeout');

  /** `new Promise(r => setTimeout(r, n))` and its spellings: a timer call inside the executor that settles it through its first parameter. */
  const checkPromise = (expression: ts.NewExpression): void => {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'Promise') return;
    const executor = expression.arguments?.[0];
    if (!executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return;
    const first = executor.parameters[0]?.name;
    if (!first || !ts.isIdentifier(first)) return;
    const resolve = first.text;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isSetTimeout(node.expression) && node.arguments[0] && mentions(node.arguments[0], resolve)) {
        report(node, 'a promise resolved by setTimeout');
      }
      ts.forEachChild(node, visit);
    };
    visit(executor.body);
  };

  const checkCall = (call: ts.CallExpression): void => {
    const callee = call.expression;
    const named = apiName(callee);
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (SNAPSHOTS.has(method)) report(callee.name, method);
      if (method === 'module' && apiName(callee.expression) === 'mock') report(callee, 'mock.module(');
      if (method === 'mock' && ts.isIdentifier(callee.expression) && (callee.expression.text === 'jest' || callee.expression.text === 'vi')) report(callee, `${callee.expression.text}.mock(`);
      if (method === 'setTimeout' && ts.isIdentifier(callee.expression) && callee.expression.text === 'jest') report(callee, 'jest.setTimeout( (raises the test time limit)');
      if (SKIPPING.has(method)) {
        const { root } = chain(callee.expression);
        if (root !== undefined && CHAIN_ROOTS.has(root)) report(callee.name, `.${method}(`);
      }
    }
    if (named !== undefined && SKIPPING_ALIASES.has(named)) report(callee, `${named}( (a skipped test)`);
    if (named === 'setDefaultTimeout') report(callee, 'setDefaultTimeout( (raises the test time limit)');
    if (named !== undefined && HOOKS.has(named) && call.arguments.length >= 2) report(call.arguments[1]!, `a timeout argument on ${named}`);
    if (definesTest(call)) {
      if (call.arguments.length >= 3) report(call.arguments[2]!, 'a timeout or retry argument on a test');
      const title = call.arguments[0];
      if (title !== undefined) cases.push({ title: titleOf(source, title), line: lineOf(call) });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) checkCall(node);
    else if (ts.isNewExpression(node)) checkPromise(node);
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Bun'
      && (node.name.text === 'sleep' || node.name.text === 'sleepSync')) report(node, `Bun.${node.name.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (table !== undefined) {
    const header = readHeader(file, text, source);
    findings.push(...header.findings);
    if (header.pairs.length > 0) findings.push(...checkRecord(file, header.pairs, cases, table));
  }
  return findings;
}

/**
 * Scan files on disk; `label` maps an absolute path to the name findings carry,
 * which is also the path from the repository root the record knows it by.
 */
export function scanTestFiles(paths: readonly string[], label: (path: string) => string = (path) => path, table?: RiskTable): ScanFinding[] {
  return paths.flatMap((path) => scanTestSource(label(path), readFileSync(path, 'utf8'), table));
}

/** Keys of a `[test]` table in bunfig.toml that would raise a limit or retry a failure. */
const BUNFIG_LIMIT_KEYS = new Set(['timeout', 'retry', 'rerunEach', 'rerun-each']);

/** `[test]` settings in a bunfig.toml that raise a limit or retry a failure, as findings. */
export function scanBunfig(file: string, text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  let table = '';
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { table = header[1]!.trim(); return; }
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    const dotted = /^test\.([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    const name = table === 'test' ? key : dotted;
    if (name !== undefined && BUNFIG_LIMIT_KEYS.has(name)) findings.push({ file, line: index + 1, rule: `bunfig [test] ${name}` });
  });
  return findings;
}

/** The test files the runner does not start, from the repository root. */
export function outsideRunnerTestFiles(root: string = REPO_ROOT): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) visit(path);
      else if (entry.isFile() && OUTSIDE_RUNNER_FILE.test(entry.name)) found.push(path);
    }
  };
  for (const directory of OUTSIDE_RUNNER_DIRECTORIES) visit(join(root, directory));
  return found.sort();
}

if (import.meta.main) {
  const named = process.argv.slice(2);
  const paths = named.length > 0 ? named.map((path) => resolve(path)) : outsideRunnerTestFiles();
  const table = readRiskTable();
  const label = (path: string): string => relative(REPO_ROOT, path).split(sep).join('/');
  const findings = [
    ...table.findings,
    ...(named.length > 0 ? [] : missingProofFiles(table)),
    ...scanTestFiles(paths, label, table),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const finding of findings) console.log(`  ${finding.file}:${finding.line}  ${finding.rule}`);
  console.log(`test-scan: ${paths.length} file(s), ${findings.length} finding(s)`);
  process.exitCode = findings.length > 0 ? 1 : 0;
}
