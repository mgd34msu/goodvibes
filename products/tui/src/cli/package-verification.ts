import type { PackageBinVerification, PackageInspectionReport } from '@goodvibes-jev/engine/terminal-shell/package-inspection';
import { readPackageManifest, inspectPackageBin, inspectTarballContents } from '@goodvibes-jev/engine/terminal-shell/package-inspection';
import { parseNpmPackJson, type NpmPackDryRunResult } from '@goodvibes-jev/engine/terminal-shell/npm-pack-report';
export { parseNpmPackJson, type NpmPackDryRunResult } from '@goodvibes-jev/engine/terminal-shell/npm-pack-report';
import { resolveWorkspaceBinary, workspaceBinaryCandidates } from './workspace-binary.ts';
import { execSync } from 'node:child_process';
import 'node:fs';
import { join } from 'node:path';

export interface PackageCliBinVerification extends PackageBinVerification<'goodvibes'> {
  readonly hasLocalPlatformBuildFallback: boolean;
  readonly hasLocalBuildFallback: boolean;
  readonly hasVendoredBinaryFallback: boolean;
  readonly hasSourceFallback: boolean;
}

export interface PackageCliVerificationReport extends PackageInspectionReport<PackageCliBinVerification> {
  readonly distribution: 'private-workspace' | 'published-package';
  readonly workspace?: { readonly binaryCandidates: readonly string[]; readonly selectedBinary: string | null };
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
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'src/main.ts',
  'bin/goodvibes',
  'src/cli/workspace-binary.ts',
  'scripts/check-bun.sh',
  'scripts/postinstall.js',
] as const;

const FORBIDDEN_TARBALL_PREFIXES = ['.github/', 'src/test/', 'src/.test/', '.goodvibes/memory/', 'vendor/'] as const;

const readPackageJson = readPackageManifest;

function verifyBin(root: string, command: (typeof REQUIRED_BIN_COMMANDS)[number], target: string | undefined): PackageCliBinVerification {
  const { bin, source } = inspectPackageBin(root, command, target);
  const expectedLocalBuild = "dist', 'goodvibes'",
    expectedSource = "src', 'main.ts'";
  return {
    ...bin,
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
  const workspace = workspaceDistribution
    ? { binaryCandidates: workspaceBinaryCandidates(root), selectedBinary: resolveWorkspaceBinary(root) ?? null }
    : undefined;
  const bin = pkg.bin && typeof pkg.bin === 'object' ? (pkg.bin as Record<string, string | undefined>) : {};
  const bins = REQUIRED_BIN_COMMANDS.map((command) => verifyBin(root, command, bin[command]));
  const pack = npmPackDryRun(root);
  const { tarball, issues: tarballIssues } = inspectTarballContents(
    pack,
    requiredTarballPaths,
    (path) => FORBIDDEN_TARBALL_PREFIXES.some((prefix) => path.startsWith(prefix)),
    'npm tarball',
  );
  const issues: string[] = [];
  for (const command of Object.keys(bin)) {
    if (!(REQUIRED_BIN_COMMANDS as readonly string[]).includes(command))
      issues.push(`package.json exposes unsupported bin entry: ${command}`);
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
  if (workspace && workspace.selectedBinary === null)
    issues.push(`private workspace has no executable build: ${workspace.binaryCandidates.join(' or ')}`);
  issues.push(...tarballIssues);

  return {
    packageName: String(pkg.name ?? ''),
    version: String(pkg.version ?? ''),
    distribution: workspaceDistribution ? 'private-workspace' : 'published-package',
    ...(workspace ? { workspace } : {}),
    bins,
    tarball,
    issues,
  };
}
