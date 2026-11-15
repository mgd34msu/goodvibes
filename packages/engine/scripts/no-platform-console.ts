import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCAN_ROOT = resolve(ROOT, 'platform/src/platform');
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['dist', 'node_modules']);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const CONSOLE_METHODS = new Set(['log', 'warn', 'error', 'info', 'debug']);

/**
 * The lines of `text` that call `console.log/warn/error/info/debug`. Parsed, not
 * pattern-matched: a `/*` or `//` inside a string or template literal is not a
 * comment, and a call named in a comment or string is not a call.
 */
export function consoleCallLines(text: string): number[] {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isNonNullExpression(node.expression) ? node.expression.expression : node.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console' && CONSOLE_METHODS.has(callee.name.text)) {
        lines.push(source.getLineAndCharacterOfPosition(callee.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function scanFile(file: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  return consoleCallLines(text).map((line) => ({
    file: relative(ROOT, file).replace(/\\/g, '/'),
    line,
    text: lines[line - 1]?.trim() ?? '',
  }));
}

if (import.meta.main) {
  const findings = walk(SCAN_ROOT).flatMap(scanFile);
  if (findings.length === 0) {
    console.log('platform-console-check: OK - no executable console.* calls in engine/src/platform.');
    process.exit(0);
  }

  console.error('platform-console-check: FAIL - use the platform logger instead of console.* in engine platform code.');
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.text}`);
  }
  process.exit(1);
}
