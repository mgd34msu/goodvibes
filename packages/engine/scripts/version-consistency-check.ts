// version-consistency-check.ts
// Verifies all workspace package.json files and compiled version fallbacks share the root version.
//
// Test-harness overrides (default behavior unchanged when env vars not set):
//   WORKSPACE_ROOT       , override the repo root directory (default: dirname of this script)
//   WORKSPACE_PACKAGES_JSON, JSON array of relative package paths to check
//                             (default: the canonical WORKSPACE_PACKAGES list below)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFallbackVersion, VERSION_FALLBACKS, VERSIONED_WORKSPACES } from './version-carriers.ts';

const ENGINE_ROOT = process.env.WORKSPACE_ROOT ?? resolve(import.meta.dir, '../../..');

// One release identity covers the foundation, platform and every product, and every
// carrier the sync script writes (see version-carriers.ts).
const DEFAULT_WORKSPACE_PACKAGES: string[] = [...VERSIONED_WORKSPACES];

function parseWorkspacePackagesJson(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
    throw new Error(
      `WORKSPACE_PACKAGES_JSON must be a JSON array of strings, got: ${raw.slice(0, 200)}`,
    );
  }
  return parsed as string[];
}

const WORKSPACE_PACKAGES: string[] = process.env.WORKSPACE_PACKAGES_JSON
  ? parseWorkspacePackagesJson(process.env.WORKSPACE_PACKAGES_JSON)
  : DEFAULT_WORKSPACE_PACKAGES;

function readVersion(pkgPath: string): string {
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string; name?: string };
  if (!parsed.version) {
    throw new Error(`No version field found in ${pkgPath}`);
  }
  return parsed.version;
}

const rootPkgPath = resolve(ENGINE_ROOT, 'package.json');
const rootVersion = readVersion(rootPkgPath);

const results: Array<{ path: string; name: string; version: string; ok: boolean }> = [];

for (const pkg of WORKSPACE_PACKAGES) {
  const pkgJsonPath = resolve(ENGINE_ROOT, pkg, 'package.json');
  const raw = readFileSync(pkgJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string; name?: string };
  const version = parsed.version ?? '(missing)';
  const name = parsed.name ?? pkg;
  results.push({
    path: `${pkg}/package.json`,
    name,
    version,
    ok: version === rootVersion,
  });
}

// The compiled fallbacks the sync script writes. A custom package list (the test
// harness override) names its own fixture tree, which has none.
if (!process.env.WORKSPACE_PACKAGES_JSON) {
  for (const fallback of VERSION_FALLBACKS) {
    const declared = readFallbackVersion(readFileSync(resolve(ENGINE_ROOT, fallback.path), 'utf8'), fallback.declaration) ?? '(missing)';
    results.push({ path: fallback.path, name: fallback.path, version: declared, ok: declared === rootVersion });
  }
}

const diverged = results.filter((r) => !r.ok);
const allOk = diverged.length === 0;

console.log(`version-consistency-check, root version: ${rootVersion}`);
console.log('');

const col = (s: string, w: number) => s.padEnd(w);
const header = `  ${col('Package', 56)}${col('Version', 12)}Status`;
console.log(header);
console.log('  ' + '-'.repeat(80));

for (const r of results) {
  const status = r.ok ? 'OK' : `DIVERGED (expected ${rootVersion})`;
  console.log(`  ${col(r.name, 56)}${col(r.version, 12)}${status}`);
}

console.log('');

if (!allOk) {
  console.error(
    `version-consistency-check FAILED: ${diverged.length} version carrier(s) diverge from root version ${rootVersion}:`,
  );
  for (const r of diverged) {
    console.error(`  ${r.name}: ${r.version} (expected ${rootVersion})`);
  }
  console.error('');
  console.error(
    'Fix: Root package.json is the source of truth. Run:\n' +
      '  bun run sync:version\n' +
      'to write it into every workspace manifest and compiled version fallback, then\n' +
      '  bun run version:check\n' +
      'to confirm consistency.',
  );
  process.exit(1);
}

console.log(`version-consistency-check PASSED, all ${results.length} version carriers at ${rootVersion}.`);
