#!/usr/bin/env bun
/**
 * security-audit.ts
 *
 * `bun audit --audit-level high`, with one allowance: an advisory that has no
 * fixed release yet, closed here by a patch to every installed copy of the
 * package. Each such advisory is listed in the root package.json under
 * `patchedAdvisories` (`{ "<GHSA id>": { "package": "<name>", "reason": "..." } }`).
 * It is passed to `bun audit --ignore` only while every version of that
 * package in bun.lock has a `patchedDependencies` entry; a version installed
 * without the patch fails the audit, naming it, before bun audit runs.
 *
 * Remove an entry, and its patches, once the package has a fixed release.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface PatchedAdvisory {
  readonly package: string;
  readonly reason: string;
}

interface RootManifest {
  readonly patchedDependencies?: Readonly<Record<string, string>>;
  readonly patchedAdvisories?: Readonly<Record<string, PatchedAdvisory>>;
}

/** Every version of `name` bun.lock resolves, from its `"<name>@<version>"` package entries. */
export function lockedVersions(lockText: string, name: string): readonly string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versions = new Set<string>();
  for (const match of lockText.matchAll(new RegExp(`: \\["${escaped}@([^"]+)"`, 'g'))) versions.add(match[1]!);
  return [...versions].sort();
}

/** The advisories to ignore, or the reasons none may be. */
export function auditAllowance(manifest: RootManifest, lockText: string): { readonly ignore: readonly string[]; readonly problems: readonly string[] } {
  const ignore: string[] = [];
  const problems: string[] = [];
  const patched = manifest.patchedDependencies ?? {};
  for (const [id, advisory] of Object.entries(manifest.patchedAdvisories ?? {})) {
    if (!/^GHSA(-[0-9a-z]{4}){3}$/.test(id) || typeof advisory.package !== 'string' || typeof advisory.reason !== 'string' || advisory.reason.trim() === '') {
      problems.push(`patchedAdvisories.${id} must be a GHSA id with a package name and a reason.`);
      continue;
    }
    const versions = lockedVersions(lockText, advisory.package);
    if (versions.length === 0) {
      problems.push(`${id}: bun.lock installs no ${advisory.package}; remove its patchedAdvisories entry and its patches.`);
      continue;
    }
    const unpatched = versions.filter((version) => patched[`${advisory.package}@${version}`] === undefined);
    if (unpatched.length > 0) {
      problems.push(`${id}: ${unpatched.map((version) => `${advisory.package}@${version}`).join(', ')} is installed without the patch that closes it; add a patchedDependencies entry for each (bun patch ${advisory.package}@<version>).`);
      continue;
    }
    ignore.push(id);
  }
  return { ignore, problems };
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as RootManifest;
  const { ignore, problems } = auditAllowance(manifest, readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8'));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`security:audit: ${problem}`);
    process.exit(1);
  }
  for (const id of ignore) console.log(`security:audit: ${id} is closed by the patches of ${manifest.patchedAdvisories![id]!.package}: ${manifest.patchedAdvisories![id]!.reason}`);
  const audit = Bun.spawnSync([process.execPath, 'audit', '--audit-level', 'high', ...ignore.flatMap((id) => ['--ignore', id])], {
    cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit',
  });
  process.exit(audit.exitCode ?? 1);
}
