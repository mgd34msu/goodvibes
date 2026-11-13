/**
 * release:prepare rewrites the version, the CHANGELOG section at the bump, which is what lets CI stop checking them on every push.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  bumpVersion,
  resumeCommandAfterBump,
  scaffoldChangelogText,
  setManifestVersionText,
} from '../../../scripts/release-prepare.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes to GoodVibes TUI.',
  '',
  '---',
  '',
  '## [2.1.0] - 2026-09-30',
  '',
  '- the previous release',
  '',
  '---',
  '',
  '## [2.0.21] - 2026-08-23',
  '',
].join('\n');

describe('scaffoldChangelogText', () => {
  test('a new version lands under the first separator, above the newest section', () => {
    const out = scaffoldChangelogText(CHANGELOG, '2.2.0', '2026-10-01');
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## [2.2.0] - 2026-10-01', '## [2.1.0] - 2026-09-30', '## [2.0.21] - 2026-08-23']);
    expect(out.startsWith('# Changelog\n\nAll notable changes to GoodVibes TUI.\n\n---\n\n## [2.2.0] - 2026-10-01\n')).toBe(true);
    expect(out.endsWith(CHANGELOG.slice(CHANGELOG.indexOf('## [2.1.0]')))).toBe(true);
  });

  test('a version that already has a section is left alone', () => {
    expect(scaffoldChangelogText(CHANGELOG, '2.1.0', '2026-10-01')).toBe(CHANGELOG);
  });

  test('a version that is a prefix of an existing one still gets its own section', () => {
    expect(scaffoldChangelogText(CHANGELOG, '2.0.2', '2026-10-01')).toContain('## [2.0.2] - 2026-10-01');
  });
});

describe('versions', () => {
  test('patch, minor and major reset the lower parts', () => {
    expect(bumpVersion('2.1.3', 'patch')).toBe('2.1.4');
    expect(bumpVersion('2.1.3', 'minor')).toBe('2.2.0');
    expect(bumpVersion('2.1.3', 'major')).toBe('3.0.0');
    expect(() => bumpVersion('latest', 'patch')).toThrow('not semver');
  });

  test('only the top-level version field changes', () => {
    const pkg = '{\n  "name": "x",\n  "version": "2.1.0",\n  "dependencies": {\n    "y": "2.1.0"\n  }\n}\n';
    expect(setManifestVersionText(pkg, '2.2.0')).toBe(pkg.replace('"version": "2.1.0"', '"version": "2.2.0"'));
  });
});

test('actual private workspace preparation refuses before commands or manifest writes', () => {
  const root = resolve(import.meta.dir, '../../..');
  const path = join(root, 'package.json');
  const before = readFileSync(path, 'utf8');
  const result = Bun.spawnSync(['bun', join(root, 'scripts/release-prepare.ts'), '--no-bump'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('refuses a private/workspace package');
  expect(readFileSync(path, 'utf8')).toBe(before);
});

describe('resumeCommandAfterBump', () => {
  test('replaces the bump choice with --no-bump and keeps the other options', () => {
    expect(resumeCommandAfterBump(['--patch', '--no-install'])).toBe('bun run release:prepare --no-bump --no-install');
    expect(resumeCommandAfterBump(['--version', '2.2.0', '--no-changelog'])).toBe('bun run release:prepare --no-bump --no-changelog');
    expect(resumeCommandAfterBump(['--minor'])).toBe('bun run release:prepare --no-bump');
  });
});
