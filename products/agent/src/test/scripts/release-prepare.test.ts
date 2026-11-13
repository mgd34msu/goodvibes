/**
 * release:prepare rewrites the version, the CHANGELOG section, the release
 * notes stamp at the bump, which is what lets CI stop
 * checking them on every push.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  bumpVersion,
  parsePrepareArgs,
  prepareRelease,
  scaffoldChangelogText,
  scaffoldReleaseNotesText,
  setManifestVersionText,
} from '../../../scripts/release-prepare.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  'Product-facing release notes for GoodVibes Agent.',
  '',
  '## 2.1.0 - 2026-09-30',
  '',
  '- the previous release',
  '',
  '## 2.0.21 - 2026-08-23',
  '',
].join('\n');

describe('scaffoldChangelogText', () => {
  test('a new version lands above the newest section, in the plain heading style', () => {
    const out = scaffoldChangelogText(CHANGELOG, '2.2.0', '2026-10-01');
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## 2.2.0 - 2026-10-01', '## 2.1.0 - 2026-09-30', '## 2.0.21 - 2026-08-23']);
    expect(out.startsWith('# Changelog\n\nProduct-facing release notes for GoodVibes Agent.\n\n## 2.2.0 - 2026-10-01\n')).toBe(true);
    expect(out.endsWith(CHANGELOG.slice(CHANGELOG.indexOf('## 2.1.0')))).toBe(true);
  });

  test('a version that already has a section is left alone', () => {
    expect(scaffoldChangelogText(CHANGELOG, '2.1.0', '2026-10-01')).toBe(CHANGELOG);
  });

  test('a version that is a prefix of an existing one still gets its own section', () => {
    expect(scaffoldChangelogText(CHANGELOG, '2.0.2', '2026-10-01')).toContain('## 2.0.2 - 2026-10-01');
  });
});

describe('scaffoldReleaseNotesText', () => {
  const CURRENT = '- Added: themes.\n\nGoodVibes Agent 2.1.0 - 2026-09-30\n';

  test('notes stamped for another version are replaced by a scaffold stamped for this one', () => {
    expect(scaffoldReleaseNotesText(CURRENT, '2.2.0', '2026-10-01')).toBe('- \n\nGoodVibes Agent 2.2.0 - 2026-10-01\n');
  });

  test('notes already stamped for this version are kept as written', () => {
    expect(scaffoldReleaseNotesText(CURRENT, '2.1.0', '2026-10-01')).toBe(CURRENT);
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

  test('exactly one bump choice is required, and each skip flag is read', () => {
    expect(() => parsePrepareArgs([])).toThrow('Usage');
    expect(() => parsePrepareArgs(['--patch', '--minor'])).toThrow('Usage');
    expect(() => parsePrepareArgs(['--version', '2.2'])).toThrow('Usage');
    expect(parsePrepareArgs(['--version', '2.2.0', '--no-live'])).toEqual({
      bump: { exact: '2.2.0' }, changelog: true, install: true, live: false,
    });
    expect(parsePrepareArgs(['--no-bump', '--no-changelog', '--no-install', '--no-pins'])).toEqual({
      bump: null, changelog: false, install: false, live: true,
    });
  });
});

describe('retained standalone release boundary', () => {
  test('retained standalone preparation leaves existing workflow pins untouched without remote lookup', async () => {
    const root = makeProjectTempDir('gv-legacy-release-prepare');
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: '@goodvibes-jev/agent', private: false, version: '2.1.0',
        devDependencies: { '@goodvibes-jev/engine': '2.1.0' },
      }));
      writeFileSync(join(root, 'README.md'), '# GoodVibes Agent\n');
      writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      const workflow = [
        `uses: mgd34msu/goodvibes/.github/workflows/release.yml@${'a'.repeat(40)} # engine 2.0.0 release`,
        'toolchain-spec: "@goodvibes-jev/engine@2.0.0"',
      ].join('\n');
      writeFileSync(join(root, '.github/workflows/release.yml'), workflow);
      const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
      await prepareRelease(['--no-bump', '--no-install', '--no-changelog', '--no-live'], {
        root,
        runCommand: (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          return { status: 0, stdout: '' };
        },
      });
      expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
        ['bun', 'run', 'scripts/prebuild.ts'],
        ['bun', 'run', 'scripts/generate-google-runbook.ts'],
      ]);
      expect(calls.every((call) => call.cwd === root)).toBe(true);
      expect(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')).toBe(workflow);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failure after the bump says the version is already bumped and names the resume command', async () => {
    const root = makeProjectTempDir('gv-release-resume');
    try {
      writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'standalone-agent', version: '2.1.0' }, null, 2)}\n`);
      let failure: unknown;
      try {
        await prepareRelease(['--patch', '--no-install', '--no-live'], {
          root,
          runCommand: () => ({ status: 1, stdout: '' }),
        });
      } catch (error) { failure = error; }
      expect(String(failure)).toContain('project surfaces failed (exit 1)');
      expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('2.1.1');
      expect(String(failure)).toContain('already bumped 2.1.0 -> 2.1.1');
      expect(String(failure)).toContain('bun run release:prepare --no-bump --no-install --no-live');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the actual private workspace refuses before any command or write', async () => {
    const root = resolve(import.meta.dir, '../../..');
    const before = readFileSync(join(root, 'package.json'), 'utf8');
    const calls: string[] = [];
    await expect(prepareRelease(['--patch'], {
      root,
      runCommand: (command) => { calls.push(command); throw new Error('must not execute'); },
    })).rejects.toThrow('refuses a private/workspace package');
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
  });

  test.each([
    { private: true },
    { private: false, dependencies: { '@goodvibes-jev/engine': 'workspace:*' } },
    { private: false, devDependencies: { '@goodvibes-jev/engine': 'workspace:^' } },
  ])('refuses %j without changing the fixture or executing commands', async (fields) => {
    const root = makeProjectTempDir('gv-release-refusal');
    try {
      const manifest = JSON.stringify({ name: '@goodvibes-jev/agent', version: '2.1.0', ...fields });
      writeFileSync(join(root, 'package.json'), manifest);
      writeFileSync(join(root, 'bun.lock'), 'unchanged lock');
      mkdirSync(join(root, 'release'));
      writeFileSync(join(root, 'release/release-notes.md'), 'unchanged notes');
      const calls: string[] = [];
      const beforeFiles = readdirSync(root, { recursive: true }).sort();
      await expect(prepareRelease(['--patch'], {
        root,
        runCommand: (command) => { calls.push(command); throw new Error('must not execute'); },
      })).rejects.toThrow('refuses a private/workspace package');
      expect(calls).toEqual([]);
      expect(readdirSync(root, { recursive: true }).sort()).toEqual(beforeFiles);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
      expect(readFileSync(join(root, 'bun.lock'), 'utf8')).toBe('unchanged lock');
      expect(readFileSync(join(root, 'release/release-notes.md'), 'utf8')).toBe('unchanged notes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
