import { parseNpmPackJson, type NpmPackDryRunResult } from '@goodvibes-jev/engine/terminal-shell/npm-pack-report';
export { parseNpmPackJson, type NpmPackDryRunResult } from '@goodvibes-jev/engine/terminal-shell/npm-pack-report';
import { resolveWorkspaceBinary, workspaceBinaryCandidates } from './workspace-binary.ts';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageCliBinVerification {
  readonly command: 'goodvibes';
  readonly target: string;
  readonly exists: boolean;
  readonly executable: boolean;
  readonly usesBunShebang: boolean;
  /** Legacy published-package fallback checks; private installs use report.workspace. */
  readonly hasLocalPlatformBuildFallback: boolean;
  readonly hasLocalBuildFallback: boolean;
  readonly hasVendoredBinaryFallback: boolean;
  readonly hasSourceFallback: boolean;
}

export interface PackageCliVerificationReport {
  readonly packageName: string;
  readonly version: string;
  readonly distribution: 'private-workspace' | 'published-package';
  /** Local build readiness is separate from the source tarball's contents. */
  readonly workspace?: { readonly binaryCandidates: readonly string[]; readonly selectedBinary: string | null };
  readonly bins: readonly PackageCliBinVerification[];
  readonly tarball: {
    readonly entryCount: number;
    readonly unpackedSize: number;
    readonly requiredPathsPresent: readonly string[];
    readonly forbiddenPaths: readonly string[];
  };
  readonly issues: readonly string[];
}

// One bin, one entry point. The daemon ships as its own package with its own
// binary; this package carrying a second wrapper is what let two daemons exist
// on one machine, built from one tree and drifting apart.
const REQUIRED_BIN_COMMANDS = ['goodvibes'] as const;
const PUBLISHED_REQUIRED_TARBALL_PATHS = [
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'src/main.ts',
  'bin/goodvibes',
  'scripts/check-bun.sh',
  'scripts/postinstall.js',
  '.goodvibes/GOODVIBES.md',
] as const;
export const WORKSPACE_REQUIRED_TARBALL_PATHS = [
  'README.md', 'CHANGELOG.md', 'package.json', 'src/main.ts', 'bin/goodvibes',
  'src/cli/workspace-binary.ts', 'scripts/check-bun.sh', 'scripts/postinstall.js',
] as const;

const FORBIDDEN_TARBALL_PREFIXES = ['.github/', 'src/test/', 'src/.test/', '.goodvibes/memory/', 'vendor/'] as const;

function readPackageJson(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
}

function hasExecutableBit(path: string): boolean {
  return existsSync(path) && (statSync(path).mode & 0o111) !== 0;
}

function verifyBin(root: string, command: typeof REQUIRED_BIN_COMMANDS[number], target: string | undefined): PackageCliBinVerification {
  const binPath = target ? join(root, target) : '';
  const source = target && existsSync(binPath) ? readFileSync(binPath, 'utf-8') : '';
  const expectedLocalBuild = "dist', 'goodvibes'";
  const expectedSource = "src', 'main.ts'";
  return {
    command,
    target: target ?? '',
    exists: Boolean(target) && existsSync(binPath),
    executable: Boolean(target) && hasExecutableBit(binPath),
    usesBunShebang: source.startsWith('#!/usr/bin/env bun'),
    hasLocalPlatformBuildFallback: source.includes("dist', artifactName"),
    hasLocalBuildFallback: source.includes(expectedLocalBuild),
    hasVendoredBinaryFallback: source.includes('vendor'),
    hasSourceFallback: source.includes(expectedSource) && source.includes("'bun'"),
  };
}

function npmPackDryRun(root: string): NpmPackDryRunResult {
  const raw = execSync('npm pack --json --dry-run', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return parseNpmPackJson(raw);
}

export function verifyPackageCliInstall(root: string): PackageCliVerificationReport {
  const pkg = readPackageJson(root);
  const dependencies = pkg.dependencies as Record<string, unknown> | undefined;
  const workspaceDistribution = pkg.private === true && dependencies?.['@goodvibes-jev/engine'] === 'workspace:*';
  const requiredTarballPaths = workspaceDistribution ? WORKSPACE_REQUIRED_TARBALL_PATHS : PUBLISHED_REQUIRED_TARBALL_PATHS;
  const workspace = workspaceDistribution ? { binaryCandidates: workspaceBinaryCandidates(root), selectedBinary: resolveWorkspaceBinary(root) ?? null } : undefined;
  const bin = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin as Record<string, string | undefined> : {};
  const bins = REQUIRED_BIN_COMMANDS.map((command) => verifyBin(root, command, bin[command]));
  const pack = npmPackDryRun(root);
  const requiredPathsPresent = requiredTarballPaths.filter((path) => pack.files.includes(path));
  const forbiddenPaths = pack.files.filter((path) => FORBIDDEN_TARBALL_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const issues: string[] = [];
  for (const command of Object.keys(bin)) {
    if (!(REQUIRED_BIN_COMMANDS as readonly string[]).includes(command)) issues.push(`package.json exposes unsupported bin entry: ${command}`);
  }

  for (const item of bins) {
    if (!item.target) issues.push(`package.json bin is missing ${item.command}.`);
    if (!item.exists) issues.push(`bin target does not exist: ${item.command} -> ${item.target}`);
    if (!item.executable) issues.push(`bin target is not executable: ${item.command} -> ${item.target}`);
    if (!item.usesBunShebang) issues.push(`bin target does not use Bun shebang: ${item.command} -> ${item.target}`);
    if (!workspaceDistribution) {
      if (!item.hasLocalPlatformBuildFallback) issues.push(`bin target lacks local platform dist fallback: ${item.command}`);
      if (!item.hasLocalBuildFallback) issues.push(`bin target lacks local dist fallback: ${item.command}`);
      if (!item.hasVendoredBinaryFallback) issues.push(`bin target lacks vendored binary fallback: ${item.command}`);
      if (!item.hasSourceFallback) issues.push(`bin target lacks Bun source fallback: ${item.command}`);
    }
  }
  if (workspace && workspace.selectedBinary === null) issues.push(`private workspace has no executable build: ${workspace.binaryCandidates.join(" or ")}`);
  for (const path of requiredTarballPaths) {
    if (!pack.files.includes(path)) issues.push(`npm tarball missing required path: ${path}`);
  }
  for (const path of forbiddenPaths) {
    issues.push(`npm tarball includes forbidden path: ${path}`);
  }

  return {
    packageName: String(pkg.name ?? ''),
    version: String(pkg.version ?? ''),
    distribution: workspaceDistribution ? 'private-workspace' : 'published-package',
    ...(workspace ? { workspace } : {}),
    bins,
    tarball: {
      entryCount: pack.entryCount,
      unpackedSize: pack.unpackedSize,
      requiredPathsPresent,
      forbiddenPaths,
    },
    issues,
  };
}
