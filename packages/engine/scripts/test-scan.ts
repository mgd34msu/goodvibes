/**
 * The admission scan the test runner applies to every selected file before any
 * file starts. A file that waits on a clock, compares against a snapshot,
 * replaces a module, skips a test, or raises its own time limit is refused, and
 * so is the whole run.
 *
 * Each file is parsed with the TypeScript parser and the forms are matched on
 * the syntax tree, so text inside a string, a template, a comment or a regular
 * expression never matches, and a method of the same name on an unrelated
 * object (`cursor.skip(2)`, `queue.todo(...)`) is not mistaken for a test
 * modifier: only calls rooted at the test API (`test`, `it`, `describe`, the
 * hooks, `mock`, or the local names a file gave them when importing from
 * `bun:test`) count.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export interface ScanFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

const TEST_DEFINERS = new Set(['test', 'it']);
const CHAIN_ROOTS = new Set(['test', 'it', 'describe']);
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const SKIPPING = new Set(['skip', 'todo', 'skipIf', 'todoIf']);
const SKIPPING_ALIASES = new Set(['xit', 'xtest', 'xdescribe']);
// Modifiers that return a test function rather than define a test.
const FACTORIES = new Set(['each', 'if', 'skipIf', 'todoIf']);
const SNAPSHOTS = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot', 'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot']);
const TIMER_PROMISE_MODULES = new Set(['timers/promises', 'node:timers/promises']);

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Scan one file's text. `file` is only used to label findings. */
export function scanTestSource(file: string, text: string): ScanFinding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const findings: ScanFinding[] = [];
  const report = (node: ts.Node, rule: string): void => {
    findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule });
  };

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
    if (definesTest(call) && call.arguments.length >= 3) report(call.arguments[2]!, 'a timeout or retry argument on a test');
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
