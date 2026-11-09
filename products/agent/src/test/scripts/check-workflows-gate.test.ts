import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const product = resolve(import.meta.dir, '../../..');
const gate = join(product, 'scripts/check-workflows.ts');
function run(directory?: string) {
  const result = Bun.spawnSync(['bun', gate, ...(directory ? [directory, '--workspace'] : [])], {
    cwd: product, stdout: 'pipe', stderr: 'pipe',
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test('product governance defaults to the actual root suite after retiring standalone release', () => {
  expect(existsSync(join(product, '.github/workflows/release.yml'))).toBe(false);
  const result = run();
  expect(result.code).toBe(0);
  expect(result.output).toContain('0 problems');
});

test('actual suite role refuses a missing suite asset owner and a remote replacement', () => {
  const directory = makeProjectTempDir('agent-suite-workflow');
  mkdirSync(join(directory, 'workflows'));
  const selected = join(directory, 'workflows');
  const original = readFileSync(resolve(product, '../../.github/workflows/release.yml'), 'utf8');
  writeFileSync(join(selected, 'release.yml'), original);
  expect(run(selected).code).toBe(0);
  writeFileSync(join(selected, 'release.yml'), original.replace('  complete-suite-assets:', '  retired-suite-assets:'));
  const missing = run(selected);
  expect(missing.code).toBe(1);
  expect(missing.output).toContain('missing the "complete-suite-assets" job');
  writeFileSync(join(selected, 'release.yml'), original.replace('./.github/workflows/suite-release-assets.yml', 'example.invalid/standalone/release.yml@main'));
  const remote = run(selected);
  expect(remote.code).toBe(1);
  expect(remote.output).toContain('must use ./.github/workflows/suite-release-assets.yml');
});
