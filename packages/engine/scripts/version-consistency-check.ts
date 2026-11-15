// version-consistency-check.ts
// Verifies every workspace package.json and compiled version fallback listed in
// version-carriers.ts shares the root version. WORKSPACE_ROOT points it at another
// tree (default: the repository root).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFallbackVersion, VERSION_FALLBACKS, VERSIONED_WORKSPACES } from './version-carriers.ts';

const ENGINE_ROOT = process.env.WORKSPACE_ROOT ?? resolve(import.meta.dir, '../../..');

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

for (const pkg of VERSIONED_WORKSPACES) {
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

for (const fallback of VERSION_FALLBACKS) {
  const declared = readFallbackVersion(readFileSync(resolve(ENGINE_ROOT, fallback.path), 'utf8'), fallback.declaration) ?? '(missing)';
  results.push({ path: fallback.path, name: fallback.path, version: declared, ok: declared === rootVersion });
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
