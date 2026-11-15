import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fallbackPattern, VERSION_FALLBACKS, VERSIONED_WORKSPACES } from './version-carriers.ts';

const root = join(import.meta.dir, '..');
const repoRoot = resolve(root, '../..');
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
const version = rootPackage.version;
if (rootPackage.name !== 'goodvibes-jev' || typeof version !== 'string'
  || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Version synchronization requires the goodvibes-jev root release identity');
}

const files = VERSION_FALLBACKS.map(target => {
  const path = join(repoRoot, target.path);
  const source = readFileSync(path, 'utf8');
  const pattern = fallbackPattern(target.declaration);
  if ([...source.matchAll(pattern)].length !== 1) throw new Error(`Expected exactly one \`let ${target.declaration} = '<version>';\` line in ${target.path}; nothing was written.`);
  const next = source.replace(
    pattern,
    `let ${target.declaration} = '${version}';`,
  );
  return { path, before: source, after: next };
});
for (const workspace of VERSIONED_WORKSPACES) {
  const path = join(repoRoot, workspace, 'package.json');
  const before = readFileSync(path, 'utf8');
  const manifest = JSON.parse(before) as { name?: unknown; version?: unknown };
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@goodvibes-jev/') || typeof manifest.version !== 'string') {
    throw new Error(`Version synchronization requires a first-party workspace manifest: ${workspace}`);
  }
  const after = manifest.version === version ? before : `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
  files.push({ path, before, after });
}
// Every write sets a carrier to the root version, so a run cut short is finished
// by running it again; nothing is rolled back.
for (const file of files) {
  if (file.after === file.before) continue;
  try {
    writeFileSync(file.path, file.after);
  } catch (error) {
    throw new Error(`Could not write ${file.path}; fix that and run \`bun run sync:version\` again.`, { cause: error });
  }
}

console.log(`synced all workspace manifests and compiled version fallbacks -> ${version}`);
