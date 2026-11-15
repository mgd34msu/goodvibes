import { readPackageManifest } from '@goodvibes-jev/engine/terminal-shell/package-inspection';
export { parseNpmPackJson, type NpmPackDryRunResult } from '@goodvibes-jev/engine/terminal-shell/npm-pack-report';
/**
 * The release-time text rules `scripts/release-prepare.ts` runs when it rewrites
 * the version stamps: the package-facing README, CHANGELOG and docs pages carry
 * no retired route or foreign package name, and every stamp agrees with
 * package.json. This workspace package is private; nothing here publishes it.
 *
 * It deliberately does not read scripts, workflows or product source as text:
 * the 2026-09 testing overhaul removed those policies (they pinned wording, not
 * behavior). See docs/testing-and-validation.md.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_PACKAGE_FACING_TEXT_PATHS = ['README.md', 'CHANGELOG.md'] as const;
const PACKAGE_FACING_FORBIDDEN_TEXT = [
  ['/api/', 'knowledge'].join(''),
  ['/api/home', 'assistant'].join(''),
  ['home', 'assistant.home', 'Graph'].join(''),
  ['include', 'AllSpaces'].join(''),
  ['knowledge', 'SpaceId'].join(''),
  ['@goodvibes-jev/goodvibes-', 'tui'].join(''),
  // The scoped name stays banned: it is the internal library the Agent links
  // against, not something a reader installs. The UNSCOPED `goodvibes-daemon`
  // is not banned: it is this package's one declared dependency (see
  // src/test/deps/dependency-check.test.ts), and the install instructions have
  // to name it, `bun pm trust -g goodvibes-daemon` is the step that lets the
  // daemon's postinstall place its binary, and `goodvibes-daemon --version` is
  // how a reader checks both commands landed. Banning the string would make
  // the README and docs/getting-started.md unwritable.
  ['@goodvibes-jev/goodvibes-', 'daemon'].join(''),
  ['~/.goodvibes/', 'tui'].join(''),
  ['Home', ' Assistant'].join(''),
  ['Home', 'Graph'].join(''),
  ['near', '-fork'].join(''),
  ['Optional ', 'Browser Access'].join(''),
  ['Optional ', 'Other-Device Access'].join(''),
  ['Optional ', 'Incoming Events'].join(''),
  ['Service ', '& Network'].join(''),
  ['Surfaces ', '& Integrations'].join(''),
  ['runtime', '-isolation'].join(''),
  ['goodvibes-agent', 'serve'].join(' '),
  ['goodvibes-agent', 'service'].join(' '),
  ['goodvibes-agent', 'services'].join(' '),
  ['goodvibes-agent', 'surfaces'].join(' '),
  ['goodvibes-agent', 'surface'].join(' '),
  ['goodvibes-agent', 'listener'].join(' '),
  ['goodvibes-agent', 'control-plane'].join(' '),
  ['goodvibes-agent', 'remote'].join(' '),
  ['goodvibes-agent', 'bridge'].join(' '),
  ['goodvibes-agent', 'web'].join(' '),
  ['goodvibes-agent', 'launch'].join(' '),
  ['goodvibes-agent', 'start'].join(' '),
  ['tui ', '[path]'].join(''),
  ['tui', '|launch'].join(''),
  ['tui', '|launch|start'].join(''),
  'Every plan must have a multi-agent execution strategy',
  'ALWAYS work in parallel when implementing a plan',
  'PRIMARY GOAL: Fully complete and functional code',
  'ReviewerReport',
  '"wrfcId"',
] as const;
/**
 * Legacy registry package names remain restricted to Agent. Public monorepo
 * engine package/export names are valid references and are not legacy packages.
 */
const ALLOWED_PACKAGE_FACING_PACKAGE_NAMES = new Set(['@goodvibes-jev/agent']);
const NON_BUN_INSTALL_COMMAND_PATTERN =
  /(?:^|[\s`])(?:npm\s+(?:install|i|exec)|npx|pnpm\s+(?:add|dlx|exec)|yarn\s+(?:add|global\s+add|dlx|exec))\b.*(?:@goodvibes-jev\/agent|goodvibes-agent)/i;
const RELEASE_NOTES_STAMP_PATTERN = /^GoodVibes Agent ([0-9]+\.[0-9]+\.[0-9]+)\s+(?:-|\u2014)\s+([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

const readPackageJson = readPackageManifest;

function readStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Every `docs/*.md` page: the package `files` list ships that whole glob, so the
 * package-facing text rules cover the same set instead of a
 * hand-kept subset that lets a shipped page go unscanned.
 */
export function packageDocPaths(root: string): readonly string[] {
  const docsPath = join(root, 'docs');
  if (!existsSync(docsPath)) return [];
  return readdirSync(docsPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `docs/${entry.name}`)
    .sort();
}

/**
 * Release-notes problems that are a property of the TEXT, so they can be tested
 * against a string instead of against a whole repository on disk.
 *
 * The version check exists because this file went seven releases without being
 * rewritten, 1.15.0's notes, describing the phone tool and triggers, shipped
 * inside the published package as late as 1.21.0. Nothing caught it: the only
 * rules here counted bullets and banned marketing words, and stale notes pass
 * both. `release/release-notes.md` is in package.json's `files` list, so what
 * this misses is what a reader opens.
 *
 * A stamp naming the release is used rather than "the notes mention the
 * version somewhere": the stale file DID contain a version string, the
 * platform runtime's, in its last bullet, and for several releases the two
 * numbers happened to coincide, so a substring rule would have been green
 * against exactly the file this is meant to reject.
 */
export function releaseNotesTextIssues(content: string, packageVersion: string): readonly string[] {
  const issues: string[] = [];
  const stampLine =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1) ?? '';
  const stamp = RELEASE_NOTES_STAMP_PATTERN.exec(stampLine);
  if (stamp === null) {
    issues.push(`release notes must end with a line naming the release, like "GoodVibes Agent ${packageVersion} - YYYY-MM-DD".`);
  } else {
    if (packageVersion.length > 0 && stamp[1] !== packageVersion) {
      issues.push(`release notes describe ${stamp[1]} but this release is ${packageVersion}, rewrite them for what is shipping.`);
    }
    const date = new Date(`${stamp[2]!}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== stamp[2]) {
      issues.push(`release notes date must be a real YYYY-MM-DD date: ${stamp[2]}.`);
    }
  }
  return issues;
}

function readTopChangelogVersion(root: string): string | null {
  const changelogPath = join(root, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) return null;
  const heading = readFileSync(changelogPath, 'utf-8')
    .split(/\r?\n/)
    .find((line) => line.startsWith('## '));
  const match = heading ? /^##\s+\[?([0-9]+\.[0-9]+\.[0-9]+)\]?\s+-\s+[0-9]{4}-[0-9]{2}-[0-9]{2}\s*$/.exec(heading) : null;
  return match ? match[1]! : null;
}

/**
 * Every file that carries the release version agrees with package.json. Run
 * after scripts/release-prepare.ts rewrites them, and by the release cut; a
 * mismatch here means a stamp was edited by hand, not a regression.
 */
export function verifyReleaseStamps(root: string): readonly string[] {
  const issues: string[] = [];
  const version = readStringValue(readPackageJson(root).version);
  const changelogVersion = readTopChangelogVersion(root);
  if (changelogVersion !== version)
    issues.push(`CHANGELOG.md top release ${changelogVersion ?? '(none)'} does not match package.json ${version}.`);
  const versionTs = existsSync(join(root, 'src', 'version.ts')) ? readFileSync(join(root, 'src', 'version.ts'), 'utf-8') : '';
  const fallback = /let _version = '([^']*)'/.exec(versionTs)?.[1];
  if (fallback !== version) issues.push(`src/version.ts fallback ${fallback ?? '(missing)'} does not match package.json ${version}.`);
  const notesPath = join(root, 'release', 'release-notes.md');
  if (!existsSync(notesPath)) issues.push('release/release-notes.md is missing.');
  else issues.push(...releaseNotesTextIssues(readFileSync(notesPath, 'utf-8'), version));
  return issues;
}

function verifyPackageFacingInstallAndPackageNames(path: string, content: string): readonly string[] {
  const failures: string[] = [];
  const lines = content.split(/\r?\n/);
  const packageNamePattern = /@goodvibes-jev\/goodvibes-[a-z0-9-]+/g;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (NON_BUN_INSTALL_COMMAND_PATTERN.test(line)) {
      failures.push(`package-facing text ${path}:${lineIndex + 1} contains non-Bun Agent install/run instruction.`);
    }
    packageNamePattern.lastIndex = 0;
    for (let match = packageNamePattern.exec(line); match !== null; match = packageNamePattern.exec(line)) {
      const packageName = match[0] ?? '';
      if (!ALLOWED_PACKAGE_FACING_PACKAGE_NAMES.has(packageName)) {
        failures.push(`package-facing text ${path}:${lineIndex + 1} references non-Agent GoodVibes package: ${packageName}`);
      }
    }
  }
  return failures;
}

/**
 * The text a reader sees on the npm page and in the installed docs (README,
 * CHANGELOG, the shipped docs pages) names no GoodVibes package but this one,
 * gives Bun install instructions only, and carries none of the retired routes
 * and TUI-only wording in PACKAGE_FACING_FORBIDDEN_TEXT. Checked at the version
 * bump (release:prepare) and in the release cut, where that text is written.
 */
export function verifyPackageFacingText(root: string): { readonly checkedPaths: readonly string[]; readonly failures: readonly string[] } {
  const failures: string[] = [];
  const paths = [...BASE_PACKAGE_FACING_TEXT_PATHS, ...packageDocPaths(root)];
  for (const path of paths) {
    const absolutePath = join(root, path);
    if (!existsSync(absolutePath)) {
      failures.push(`package-facing text is missing: ${path}`);
      continue;
    }
    const content = readFileSync(absolutePath, 'utf-8');
    failures.push(...verifyPackageFacingInstallAndPackageNames(path, content));
    for (const forbidden of PACKAGE_FACING_FORBIDDEN_TEXT) {
      if (content.includes(forbidden)) {
        failures.push(`package-facing text ${path} contains forbidden default/TUI route or policy: ${forbidden}`);
      }
    }
  }
  return { checkedPaths: paths, failures };
}
