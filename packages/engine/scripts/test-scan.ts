/**
 * The admission scan the test runner applies to selected files before running.
 * Refuses flaky/anti-pattern forms: clock sleeps (`Bun.sleep`, `setTimeout`-resolved
 * promises, `timers/promises`), snapshot matchers, module mocks (`mock.module`,
 * `jest.mock`, `vi.mock`), and committed `.skip`/`.todo` modifiers.
 *
 * Each file is parsed with the TypeScript parser so strings, templates, comments,
 * and unrelated object methods never match.
 *
 *   bun packages/engine/scripts/test-scan.ts             scan Playwright journeys outside the bun runner
 *   bun packages/engine/scripts/test-scan.ts <file>...   scan the named files
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface ScanFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** Test files the runner does not start: the web UI's Playwright journeys run under Playwright. */
const OUTSIDE_RUNNER_DIRECTORIES = ['products/webui/e2e'];
const OUTSIDE_RUNNER_FILE = /\.e2e\.ts$/;

const CHAIN_ROOTS = new Set(['test', 'it', 'describe']);
const SKIPPING = new Set(['skip', 'todo', 'skipIf', 'todoIf']);
const SKIPPING_ALIASES = new Set(['xit', 'xtest', 'xdescribe']);
const SNAPSHOTS = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot', 'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot']);
const TIMER_PROMISE_MODULES = new Set(['timers/promises', 'node:timers/promises']);

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Scan one file's text for disallowed flaky/mock test forms. */
export function scanTestSource(file: string, text: string): ScanFinding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const findings: ScanFinding[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node: ts.Node, rule: string): void => {
    findings.push({ file, line: lineOf(node), rule });
  };

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

  const apiName = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) return expression.name.text;
    return undefined;
  };

  const chain = (callee: ts.Expression): { root: string | undefined; modifiers: string[] } => {
    const modifiers: string[] = [];
    let current = callee;
    for (;;) {
      const named = apiName(current);
      if (named !== undefined && (CHAIN_ROOTS.has(named) || SKIPPING_ALIASES.has(named))) return { root: named, modifiers };
      if (ts.isPropertyAccessExpression(current)) { modifiers.unshift(current.name.text); current = current.expression; }
      else if (ts.isCallExpression(current)) current = current.expression;
      else return { root: undefined, modifiers };
    }
  };

  const mentions = (node: ts.Node, name: string): boolean => {
    if (ts.isIdentifier(node) && node.text === name) return true;
    return ts.forEachChild(node, (child) => mentions(child, name) || undefined) ?? false;
  };

  const isSetTimeout = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && callee.text === 'setTimeout')
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'setTimeout');

  const checkPromise = (expression: ts.NewExpression): void => {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'Promise') return;
    const executor = expression.arguments?.[0];
    if (!executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return;
    const first = executor.parameters[0]?.name;
    if (!first || !ts.isIdentifier(first)) return;
    const resolveName = first.text;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isSetTimeout(node.expression) && node.arguments[0] && mentions(node.arguments[0], resolveName)) {
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
      if (SKIPPING.has(method)) {
        const { root } = chain(callee.expression);
        if (root !== undefined && CHAIN_ROOTS.has(root)) report(callee.name, `.${method}(`);
      }
    }
    if (named !== undefined && SKIPPING_ALIASES.has(named)) report(callee, `${named}( (a skipped test)`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) checkCall(node);
    else if (ts.isNewExpression(node)) checkPromise(node);
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Bun'
      && (node.name.text === 'sleep' || node.name.text === 'sleepSync')) report(node, `Bun.${node.name.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);

  return findings;
}

/** Scan files on disk; `label` maps an absolute path to the name findings carry. */
export function scanTestFiles(paths: readonly string[], label: (path: string) => string = (path) => path): ScanFinding[] {
  return paths.flatMap((path) => scanTestSource(label(path), readFileSync(path, 'utf8')));
}

/** Keys of a `[test]` table in bunfig.toml that would retry a failure. */
const BUNFIG_RETRY_KEYS = new Set(['retry', 'rerunEach', 'rerun-each']);

/** `[test]` settings in a bunfig.toml that retry failures, as findings. */
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
    if (name !== undefined && BUNFIG_RETRY_KEYS.has(name)) findings.push({ file, line: index + 1, rule: `bunfig [test] ${name}` });
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
  const label = (path: string): string => relative(REPO_ROOT, path).split(sep).join('/');
  const findings = scanTestFiles(paths, label).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const finding of findings) console.log(`  ${finding.file}:${finding.line}  ${finding.rule}`);
  console.log(`test-scan: ${paths.length} file(s), ${findings.length} finding(s)`);
  process.exitCode = findings.length > 0 ? 1 : 0;
}
