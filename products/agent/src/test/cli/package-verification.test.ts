import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  parseNpmPackJson,
  releaseNotesTextIssues,
  verifyPackageFacingText,
  verifyReleaseStamps,
} from '../../cli/package-verification.ts';

function withFixture(run: (dir: string) => void): void {
  const dir = makeProjectTempDir('goodvibes-agent-package-verification');
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STAMPED_NOTES = [
  '- Added: themes.',
  '- Fixed: indented read bodies.',
  '',
  'GoodVibes Agent 2.1.0 - 2026-09-30',
  '',
].join('\n');

describe('version stamps agree after the bump', () => {
  function writeStamps(dir: string, versions: { pkg: string; changelog: string; versionTs: string; notes: string }): void {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'release'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: versions.pkg }));
    writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${versions.changelog} - 2026-09-30\n\n- Notes.\n`);
    writeFileSync(join(dir, 'src', 'version.ts'), `let _version = '${versions.versionTs}';\n`);
    writeFileSync(join(dir, 'release', 'release-notes.md'), `- Notes.\n\nGoodVibes Agent ${versions.notes} - 2026-09-30\n`);
  }

  test('matching stamps pass', () => {
    withFixture((dir) => {
      writeStamps(dir, { pkg: '2.2.0', changelog: '2.2.0', versionTs: '2.2.0', notes: '2.2.0' });
      expect(verifyReleaseStamps(dir)).toEqual([]);
    });
  });

  test('each stale stamp is named', () => {
    withFixture((dir) => {
      writeStamps(dir, { pkg: '2.2.0', changelog: '2.1.0', versionTs: '2.1.0', notes: '2.1.0' });
      expect(verifyReleaseStamps(dir)).toEqual([
        'CHANGELOG.md top release 2.1.0 does not match package.json 2.2.0.',
        'src/version.ts fallback 2.1.0 does not match package.json 2.2.0.',
        'release notes describe 2.1.0 but this release is 2.2.0, rewrite them for what is shipping.',
      ]);
    });
  });
});

describe('package-facing text preserves public engine references and legacy exclusions', () => {
  test('public engine and platform export names are valid package-facing text', () => {
    withFixture((dir) => {
      writeFileSync(join(dir, 'README.md'), 'Built on @goodvibes-jev/engine and @goodvibes-jev/engine/platform.\n');
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
      expect(verifyPackageFacingText(dir).failures).toEqual([]);
    });
  });

  test('another GoodVibes package name and a non-Bun install line are reported; the bundled-runtime wording passes', () => {
    withFixture((dir) => {
      writeFileSync(join(dir, 'README.md'), [
        '# GoodVibes Agent',
        'Install with `bun add -g @goodvibes-jev/agent`.',
        'It ships with the bundled GoodVibes platform runtime.',
        'Built on @goodvibes-jev/engine/platform.',
        'Legacy package: @goodvibes-jev/goodvibes-legacy-platform.',
        'Or run `npm install -g @goodvibes-jev/agent`.',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 2.1.0 - 2026-09-30\n\n- Notes.\n');
      expect(verifyPackageFacingText(dir).failures).toEqual([
        'package-facing text README.md:5 references non-Agent GoodVibes package: @goodvibes-jev/goodvibes-legacy-platform',
        'package-facing text README.md:6 contains non-Bun Agent install/run instruction.',
      ]);
    });
  });
});

describe('package-facing text covers every shipped docs page', () => {
  test('a docs page the package ships is scanned even when no list names it', () => {
    withFixture((dir) => {
      writeFileSync(join(dir, 'README.md'), '# GoodVibes Agent\n');
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', 'headless-run.md'), `Use ${['/api/', 'knowledge'].join('')}/ask for questions.\n`);
      const report = verifyPackageFacingText(dir);
      expect(report.checkedPaths).toContain('docs/headless-run.md');
      expect(report.failures.some((failure) => failure.includes('docs/headless-run.md') && failure.includes('forbidden'))).toBe(true);
    });
  });
});

describe('shipped release notes describe the release being shipped', () => {
  // release/release-notes.md is in package.json's `files` list, so it travels
  // inside the published package. It went seven releases without being
  // rewritten, 1.15.0's notes were still what a reader opened at 1.21.0,
  // because the only rules were "at least five bullets" and "no marketing
  // words", and stale notes pass both. release:prepare scaffolds the stamp at
  // the bump; the release cut refuses a stamp for another version.
  test('notes left over from an earlier release are rejected by version', () => {
    // The exact failure that shipped: the file is well-formed, has plenty of
    // bullets, contains no hype, and describes a release that is not this one.
    const issues = releaseNotesTextIssues(STAMPED_NOTES, '9.9.9');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('describe 2.1.0');
    expect(issues[0]).toContain('this release is 9.9.9');
  });

  test('the real stale file this rule was written for is rejected', () => {
    // The genuine 1.15.0-era notes, abbreviated. Note the last bullet DOES
    // carry a version string, the platform runtime's, which is why the rule
    // is a stamp naming the release and not "the text mentions the version".
    const stale = [
      '- A paired phone is now something Agent can use.',
      '- Nothing is taken from a phone quietly.',
      '- Added triggers: watch something, and act when it changes.',
      '- Wake-word detection has platform support.',
      '- Fixed: a conversation that had already written to you could get no reply.',
      '- Updated the bundled GoodVibes platform runtime to 1.15.0.',
      '',
    ].join('\n');
    const issues = releaseNotesTextIssues(stale, '1.22.1');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('must end with a line naming the release');
  });

  test('a stamp naming another version is rejected even when the text mentions this one', () => {
    // NO-proof that the rule reads the stamp rather than scanning for the
    // version anywhere: this body names 1.22.1 twice and still fails.
    const misstamped = [
      '- Updated the bundled GoodVibes platform runtime for 1.22.1.',
      '- A second bullet mentioning 1.22.1 again.',
      '',
      'GoodVibes Agent 1.21.0 - 2026-07-27',
      '',
    ].join('\n');
    const issues = releaseNotesTextIssues(misstamped, '1.22.1');
    expect(issues).toEqual(['release notes describe 1.21.0 but this release is 1.22.1, rewrite them for what is shipping.']);
  });

  test('an unreal date in the stamp is rejected', () => {
    const badDate = ['- One bullet.', '', 'GoodVibes Agent 1.22.1 - 2026-02-31', ''].join('\n');
    expect(releaseNotesTextIssues(badDate, '1.22.1')).toEqual([
      'release notes date must be a real YYYY-MM-DD date: 2026-02-31.',
    ]);
  });

  test('an em dash in the stamp is accepted, because it is the house style', () => {
    const emDash = ['- One bullet.', '', 'GoodVibes Agent 1.22.1 \u2014 2026-07-29', ''].join('\n');
    expect(releaseNotesTextIssues(emDash, '1.22.1')).toEqual([]);
  });
});

describe('npm pack --json output parsing', () => {
  const arrayShape = JSON.stringify([
    { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  ]);
  const objectShape = JSON.stringify({
    pkg: { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  });

  test('reads the array shape emitted by npm 10 and npm 11', () => {
    expect(parseNpmPackJson(arrayShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads the package-name-keyed object shape emitted by npm 12', () => {
    expect(parseNpmPackJson(objectShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads a bare pack-result object', () => {
    expect(parseNpmPackJson(JSON.stringify({ entryCount: 1, unpackedSize: 7, files: [{ path: 'a.txt' }] }))).toEqual({
      files: ['a.txt'],
      entryCount: 1,
      unpackedSize: 7,
    });
  });

  test('ignores npm notice lines printed around the JSON document', () => {
    const noisy = `npm notice run \`npm audit\` for details\n${objectShape}\nnpm notice done\n`;
    expect(parseNpmPackJson(noisy)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('keeps braces inside file paths from truncating the document', () => {
    const braced = JSON.stringify({ pkg: { entryCount: 1, unpackedSize: 3, files: [{ path: 'src/{weird}/file.ts' }] } });
    expect(parseNpmPackJson(`npm notice packing\n${braced}`)).toEqual({
      files: ['src/{weird}/file.ts'],
      entryCount: 1,
      unpackedSize: 3,
    });
  });

  test('reports what npm actually emitted when there is no JSON document', () => {
    expect(() => parseNpmPackJson('npm error code ENOENT\nnpm error enoent\n')).toThrow(/printed no JSON document.*npm error code ENOENT/s);
  });

  test('reports what npm actually emitted when the output is empty', () => {
    expect(() => parseNpmPackJson('   \n')).toThrow(/printed no JSON document.*no output at all/s);
  });

  test('reports what npm actually emitted when the JSON is malformed', () => {
    expect(() => parseNpmPackJson('{"pkg": {files: [1, 2]}}')).toThrow(/could not be parsed/);
  });

  test('reports an unrecognized JSON shape rather than crashing', () => {
    expect(() => parseNpmPackJson(JSON.stringify({ error: { code: 'E404', summary: 'not found' } }))).toThrow(
      /unrecognized JSON shape.*E404/s,
    );
  });
});
