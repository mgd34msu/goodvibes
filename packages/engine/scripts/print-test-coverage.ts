/** Print the monorepo test-file navigation map; this is not execution coverage. */
import { execFileSync } from 'node:child_process';
import { posix, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const workspaces = [
  ['packages/judgment/', 'Judgment foundation'],
  ['packages/engine/', 'Engine platform'],
  ['products/daemon/', 'Daemon'],
  ['products/tui/', 'Terminal UI'],
  ['products/agent/', 'Agent'],
  ['products/webui/', 'Web UI'],
] as const;
const candidates = execFileSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '--',
  '*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx',
], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const files = [...new Set(candidates.trim().split('\n'))]
  .filter(file => file && !/(?:^|\/)(?:vendor|generated|dist|node_modules)\//.test(file))
  .sort();
const lines = [
  '# Test Coverage Map', '',
  'Status: generated test-file navigation for the current monorepo checkout.', '',
  'This map lists files, not measured branch coverage or proof that every test has run.',
  'It includes nested suites and product tests; generated/vendor/build files are excluded.', '',
  'Regenerate from the repository root:', '',
  '```sh',
  'bun packages/engine/scripts/print-test-coverage.ts > .goodvibes/dev/packages/engine/COVERAGE.md',
  '```', '',
];
for (const [prefix, title] of workspaces) {
  const selected = files.filter(file => file.startsWith(prefix));
  lines.push(`## ${title} (${selected.length} files)`, '', '| File |', '| --- |');
  for (const file of selected) {
    lines.push(`| [${file}](${posix.relative('packages/engine', file)}) |`);
  }
  lines.push('');
}
console.log(lines.join('\n'));
