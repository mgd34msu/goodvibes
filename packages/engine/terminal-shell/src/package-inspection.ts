import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NpmPackDryRunResult } from './npm-pack-report.js';
export function readPackageManifest(root: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package.json must contain a JSON object.');
  return value as Record<string, unknown>;
}
export function inspectPackageBin<Command extends string>(root: string, command: Command, target: string | undefined) {
  const path = target ? join(root, target) : '';
  const exists = Boolean(target) && existsSync(path);
  const source = exists ? readFileSync(path, 'utf-8') : '';
  return {
    source,
    bin: {
      command,
      target: target ?? '',
      exists,
      executable: exists && (statSync(path).mode & 0o111) !== 0,
      usesBunShebang: source.startsWith('#!/usr/bin/env bun'),
    },
  };
}
export function inspectTarballContents(
  pack: NpmPackDryRunResult,
  required: readonly string[],
  forbidden: (path: string) => boolean,
  label: string,
) {
  const requiredPathsPresent = required.filter((path) => pack.files.includes(path));
  const forbiddenPaths = pack.files.filter(forbidden);
  return {
    tarball: { entryCount: pack.entryCount, unpackedSize: pack.unpackedSize, requiredPathsPresent, forbiddenPaths },
    issues: [
      ...required.filter((path) => !pack.files.includes(path)).map((path) => label + ' missing required path: ' + path),
      ...forbiddenPaths.map((path) => label + ' includes forbidden path: ' + path),
    ],
  };
}

export interface PackageBinVerification<Command extends string> {
  readonly command: Command;
  readonly target: string;
  readonly exists: boolean;
  readonly executable: boolean;
  readonly usesBunShebang: boolean;
}
export interface PackageInspectionReport<Bin> {
  readonly packageName: string;
  readonly version: string;
  readonly bins: readonly Bin[];
  readonly tarball: {
    readonly entryCount: number;
    readonly unpackedSize: number;
    readonly requiredPathsPresent: readonly string[];
    readonly forbiddenPaths: readonly string[];
  };
  readonly issues: readonly string[];
}

export function packageBinIssues(item: PackageBinVerification<string>): string[] {
  const issues: string[] = [];
  if (!item.target) issues.push(`package.json bin is missing ${item.command}.`);
  if (!item.exists) issues.push(`bin target does not exist: ${item.command} -> ${item.target}`);
  if (!item.executable) issues.push(`bin target is not executable: ${item.command} -> ${item.target}`);
  if (!item.usesBunShebang) issues.push(`bin target does not use Bun shebang: ${item.command} -> ${item.target}`);
  return issues;
}
export function packageBinTargets(pkg: Record<string, unknown>): Record<string, string | undefined> {
  return pkg.bin && typeof pkg.bin === 'object' ? (pkg.bin as Record<string, string | undefined>) : {};
}
