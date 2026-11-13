#!/usr/bin/env bun
/**
 * Retained standalone release:prepare flow. The private workspace is refused
 * before any command or write; pure helpers remain useful for legacy fixtures.
 *
 * Generated product files and version stamps are rewritten here at the bump,
 * instead of being policed by a red
 * CI run on every push. A stale generated file is fixed by regenerating it; it
 * is not a regression.
 *
 * Usage:
 *   bun run release:prepare --patch | --minor | --major
 *   bun run release:prepare --version 2.2.0     bump to an exact version
 *   bun run release:prepare --no-bump           regenerate at the current version
 *   bun run release:prepare --no-bump --no-changelog --no-live
 *                                               the npm `version` hook and the
 *                                               release cut's sync command (they
 *                                               bump the manifest and write the
 *                                               changelog section themselves)
 *   --no-install   skip the relock (offline, or the lockfile is already current)
 *   --no-pins      accepted for old invocations; workflow pins are no longer rewritten
 *   --no-live      skip the live-verification report refresh (no connected
 *                  host running on this machine)
 *
 * Steps, in dependency order:
 *   1. package.json version (unless --no-bump)
 *   2. relock: `bun install`, so bun.lock and node_modules resolve the pinned
 *      engine, daemon and toolchain versions from package.json
 *   3. project surfaces, in a fresh process (scripts/prebuild.ts): the
 *      src/version.ts fallback, the README badge, the docs/README release line
 *   4. docs/google-setup-runbook.md from the pinned engine's step plan
 *   5. a `## X.Y.Z - YYYY-MM-DD` CHANGELOG section and a release/release-notes.md
 *      scaffold ending in `GoodVibes Agent X.Y.Z - YYYY-MM-DD`, when the version
 *      has none yet (unless --no-changelog)
 *   6. release/live-verification/: build the binary and run the live verifier
 *      in strict mode against it and the connected host (unless --no-live)
 *   7. the package-facing text rule (README, CHANGELOG and shipped docs name no
 *      GoodVibes package but this one) and the version-stamp agreement; a
 *      failure here is printed and exits non-zero
 *
 * Suite workflows are owned by the monorepo release; this command never
 * rewrites workflow pins or looks up remote release tags.
 * It never commits, tags or pushes. Review `git diff` afterwards and write the
 * release notes into the scaffolded sections.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertStandaloneReleaseAllowed } from './standalone-release-policy.ts';

const ROOT = join(import.meta.dir, '..');
const RELEASE_NOTES_PATH = join('release', 'release-notes.md');

export type BumpKind = 'patch' | 'minor' | 'major';

/** The next semver for a bump kind. Pre-release suffixes are dropped. */
export function bumpVersion(current: string, kind: BumpKind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!match) throw new Error(`package.json version is not semver: ${current}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Rewrites only the top-level "version" field, leaving the rest of the file's bytes alone. */
export function setManifestVersionText(text: string, version: string): string {
  const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    throw new Error('package.json has no top-level "version" field');
  }
  return next;
}

/**
 * CHANGELOG text with a `## X.Y.Z - YYYY-MM-DD` section (this changelog's plain
 * heading style) inserted above the newest `## ` heading, or appended when
 * there is none. Unchanged when a section for the version already exists.
 */
export function scaffoldChangelogText(changelog: string, version: string, date: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^##\\s*\\[?${escaped}\\]?\\s`, 'm').test(changelog)) return changelog;
  const section = `## ${version} - ${date}\n\n- \n\n`;
  const first = changelog.search(/^## /m);
  if (first === -1) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, first)}${section}${changelog.slice(first)}`;
}

/**
 * The release notes for `version`: the current text when its closing stamp
 * already names this version, otherwise a scaffold ending in the stamp line the
 * release lane reads (`GoodVibes Agent X.Y.Z - YYYY-MM-DD`).
 */
export function scaffoldReleaseNotesText(current: string, version: string, date: string): string {
  const lastLine = current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  if (new RegExp(`^GoodVibes Agent ${version.replace(/\./g, '\\.')}\\s+(?:-|—)\\s+\\d{4}-\\d{2}-\\d{2}$`).test(lastLine)) {
    return current;
  }
  return `- \n\nGoodVibes Agent ${version} - ${date}\n`;
}

interface PrepareArgs {
  readonly bump: BumpKind | { readonly exact: string } | null;
  readonly changelog: boolean;
  readonly install: boolean;
  readonly live: boolean;
}

export function parsePrepareArgs(argv: readonly string[]): PrepareArgs {
  const kinds = (['patch', 'minor', 'major'] as const).filter((kind) => argv.includes(`--${kind}`));
  const versionIdx = argv.indexOf('--version');
  const exact = versionIdx >= 0 ? argv[versionIdx + 1] : undefined;
  const noBump = argv.includes('--no-bump');
  const chosen = kinds.length + (versionIdx >= 0 ? 1 : 0) + (noBump ? 1 : 0);
  if (chosen !== 1 || (versionIdx >= 0 && (exact === undefined || !/^\d+\.\d+\.\d+$/.test(exact)))) {
    throw new Error('Usage: bun run release:prepare (--patch | --minor | --major | --version X.Y.Z | --no-bump) [--no-changelog] [--no-install] [--no-pins] [--no-live]');
  }
  return {
    bump: noBump ? null : exact !== undefined ? { exact } : kinds[0]!,
    changelog: !argv.includes('--no-changelog'),
    install: !argv.includes('--no-install'),
    live: !argv.includes('--no-live'),
  };
}

export interface PrepareCommandOptions {
  readonly cwd: string;
  readonly captureOutput: boolean;
  readonly timeout?: number;
}

export type PrepareCommandRunner = (
  command: string,
  args: readonly string[],
  options: PrepareCommandOptions,
) => { readonly status: number | null; readonly stdout: string };

const runPrepareCommand: PrepareCommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  return { status: result.status, stdout: result.stdout ?? '' };
};

/**
 * The command that continues a run whose version bump already happened: the same
 * options with the bump choice replaced by `--no-bump`, so the version is not bumped again.
 */
export function resumeCommandAfterBump(argv: readonly string[]): string {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--patch' || arg === '--minor' || arg === '--major' || arg === '--no-bump') continue;
    if (arg === '--version') { i += 1; continue; }
    kept.push(arg);
  }
  return ['bun', 'run', 'release:prepare', '--no-bump', ...kept].join(' ');
}

function afterBumpFailure(error: unknown, argv: readonly string[], from: string, to: string): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `${reason}\n[release:prepare] package.json was already bumped ${from} -> ${to} and stays at ${to}; the steps after it are safe to repeat.\n`
    + `  Resume at ${to} (do NOT repeat the bump option; it would bump again): ${resumeCommandAfterBump(argv)}\n`
    + `  Or abandon the bump: git checkout -- package.json`,
  );
}

function run(root: string, execute: PrepareCommandRunner, label: string, command: string, args: readonly string[]): void {
  console.log(`[release:prepare] ${label}: ${command} ${args.join(' ')}`);
  const result = execute(command, args, { cwd: root, captureOutput: false });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? 'signal'})`);
}

function rewriteFile(root: string, relativePath: string, rewrite: (text: string) => string): boolean {
  const path = join(root, relativePath);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const after = rewrite(before);
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

export async function prepareRelease(
  argv: readonly string[],
  options: { readonly root?: string; readonly runCommand?: PrepareCommandRunner } = {},
): Promise<void> {
  const root = options.root ?? ROOT;
  const execute = options.runCommand ?? runPrepareCommand;
  const args = parsePrepareArgs(argv);
  const pkgPath = join(root, 'package.json');
  const pkgText = readFileSync(pkgPath, 'utf8');
  const manifest = JSON.parse(pkgText) as Record<string, unknown>;
  assertStandaloneReleaseAllowed(manifest, 'release:prepare');
  const current = String(manifest.version ?? '');

  let version = current;
  if (args.bump !== null) {
    version = typeof args.bump === 'string' ? bumpVersion(current, args.bump) : args.bump.exact;
    writeFileSync(pkgPath, setManifestVersionText(pkgText, version));
    console.log(`[release:prepare] package.json ${current} -> ${version}`);
  }

  try {
    if (args.install) run(root, execute, 'relock', 'bun', ['install']);
    run(root, execute, 'project surfaces', 'bun', ['run', 'scripts/prebuild.ts']);
    run(root, execute, 'google setup runbook', 'bun', ['run', 'scripts/generate-google-runbook.ts']);

    if (args.changelog) {
      const date = new Date().toISOString().slice(0, 10);
      console.log(rewriteFile(root, 'CHANGELOG.md', (text) => scaffoldChangelogText(text, version, date))
        ? `[release:prepare] CHANGELOG.md: scaffolded ## ${version}; write the notes before pushing.`
        : `[release:prepare] CHANGELOG.md already has a ## ${version} section.`);
      console.log(rewriteFile(root, RELEASE_NOTES_PATH, (text) => scaffoldReleaseNotesText(text, version, date))
        ? `[release:prepare] ${RELEASE_NOTES_PATH}: scaffolded for ${version}; write the notes before pushing.`
        : `[release:prepare] ${RELEASE_NOTES_PATH} already names ${version}.`);
    }

    if (args.live) {
      run(root, execute, 'build', 'bun', ['run', 'build']);
      run(root, execute, 'live verification report', 'bun', ['run', 'scripts/verify-live.ts', '--strict', '--out', join('release', 'live-verification')]);
    }

    // Imported here, after the relock, so the check reads the files this run wrote.
    const { verifyPackageFacingText, verifyReleaseStamps } = await import('../src/cli/package-verification.ts');
    const issues = [...verifyPackageFacingText(root).failures, ...(args.changelog ? verifyReleaseStamps(root) : [])];
    if (issues.length > 0) {
      throw new Error(`package-facing text or version stamps need a fix:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    }
  } catch (error) {
    throw args.bump === null ? error : afterBumpFailure(error, argv, current, version);
  }
  console.log('[release:prepare] done; review `git diff`.');
}

if (import.meta.main) {
  try {
    await prepareRelease(process.argv.slice(2));
  } catch (error) {
    console.error(`[release:prepare] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
