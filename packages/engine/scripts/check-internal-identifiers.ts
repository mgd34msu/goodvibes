// check-internal-identifiers.ts
//
// Pre-release gate: internal planning labels (wave / work-order / debt-register /
// UX-workstream ids) and unfinished-work comment markers must not appear in
// tracked text. Pure regex over the source tree, no stored state.
// docs/decisions/** is the sanctioned home for planning shorthand.
//
//   bun run internal-id:check
//
// Test override: INTERNAL_ID_ROOT replaces the engine package root.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const INTERNAL_ID_ROOT = process.env.INTERNAL_ID_ROOT ?? resolve(import.meta.dir, '..');

const ID_PATTERNS: readonly RegExp[] = [
  /\bW\d+\.\d+\b/, // wave.item
  /\bWO-[0-9A-Z]+\b/, // work-order
  /\bwo\d{3}\b/, // numeric work-order
  /\bDEBT-\d+\b/, // debt register
  /\bUX-[A-Z]\b/, // UX workstream
  /\bWave[ -]\d+\b/, // wave word-form
  /\bW\d+-R\d+\b/, // wave round
];
const MARKER_PATTERN = /(?:\/\/|\/\*|^\s*\*|#)\s*(?:TODO|FIXME|XXX|HACK)\b/;

const SELF = new Set(['scripts/check-internal-identifiers.ts', 'test/internal-identifier-check.test.ts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'generated', 'vendor']);
const TEXT_EXT = /\.(?:ts|tsx|mjs|js|md|json)$/;
const CODE_EXT = /\.(?:ts|tsx|mjs|js)$/;

export function findViolations(relPath: string, text: string): string[] {
  const path = relPath.split('\\').join('/');
  if (path.startsWith('docs/decisions/') || SELF.has(path)) return [];
  const checkMarkers = CODE_EXT.test(path) && !/\.(?:test|spec)\./.test(path) && !path.startsWith('test/');
  const found: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (ID_PATTERNS.some(pattern => pattern.test(line))) found.push(`${path}:${index + 1}: internal planning identifier; use plain language or a decision-record path`);
    else if (checkMarkers && MARKER_PATTERN.test(line)) found.push(`${path}:${index + 1}: unfinished-work marker`);
  });
  return found;
}

function* textFiles(root: string, target: string): Generator<string> {
  const base = join(root, target);
  if (!existsSync(base)) return;
  if (TEXT_EXT.test(base)) { yield target; return; }
  for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !TEXT_EXT.test(entry.name)) continue;
    const rel = join(entry.parentPath, entry.name).slice(root.length + 1);
    if (!rel.split(/[\\/]/).some(part => SKIP_DIRS.has(part))) yield rel;
  }
}

export function scanTree(root = INTERNAL_ID_ROOT): { files: number; violations: string[] } {
  const targets = ['scripts', 'docs', 'test', 'eval', 'examples', 'SECURITY.md', 'CHANGELOG.md', 'README.md',
    ...readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(root, e.name, 'src'))).map(e => `${e.name}/src`)];
  let files = 0;
  const violations: string[] = [];
  for (const target of targets) for (const rel of textFiles(root, target)) {
    files++;
    violations.push(...findViolations(rel, readFileSync(join(root, rel), 'utf8')));
  }
  return { files, violations };
}

if (import.meta.main) {
  const { files, violations } = scanTree();
  if (violations.length > 0) {
    console.error(`internal-identifier-check FAILED: ${violations.length} finding(s).\n`);
    for (const violation of violations.slice(0, 100)) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log(`internal-identifier-check PASSED: ${files} text files.`);
}
