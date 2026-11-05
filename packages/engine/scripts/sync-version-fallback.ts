import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = join(import.meta.dir, '..');
const repoRoot = resolve(root, '../..');
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
const version = rootPackage.version;
if (rootPackage.name !== 'goodvibes-jev' || typeof version !== 'string'
  || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Version synchronization requires the goodvibes-jev root release identity');
}

const targets = [
  { path: join(root, 'sdk', 'src', 'platform', 'version.ts'), declaration: 'version' },
  { path: join(repoRoot, 'products/daemon/src/version.ts'), declaration: '_version' },
  { path: join(repoRoot, 'products/tui/src/version.ts'), declaration: '_version' },
  { path: join(repoRoot, 'products/agent/src/version.ts'), declaration: '_version' },
];

const files = targets.map(target => {
  const source = readFileSync(target.path, 'utf8');
  const pattern = new RegExp(`^let ${target.declaration} = ['"][^'"\\r\\n]*['"];+$`, 'gm');
  if ([...source.matchAll(pattern)].length !== 1) throw new Error('Expected exactly one compiled version fallback');
  const next = source.replace(
    pattern,
    `let ${target.declaration} = '${version}';`,
  );
  return { path: target.path, before: source, after: next };
});
for (const workspace of ['packages/engine', 'packages/judgment', 'products/daemon', 'products/tui', 'products/agent', 'products/webui',
  ...['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].map(platform => `products/tui/platform-packages/${platform}`)]) {
  const path = join(repoRoot, workspace, 'package.json');
  const before = readFileSync(path, 'utf8');
  const manifest = JSON.parse(before) as { name?: unknown; version?: unknown };
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@goodvibes-jev/') || typeof manifest.version !== 'string') {
    throw new Error(`Version synchronization requires a first-party workspace manifest: ${workspace}`);
  }
  const after = manifest.version === version ? before : `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
  files.push({ path, before, after });
}
const attempted: typeof files = [];
try {
  for (const file of files) {
    if (file.after === file.before) continue;
    attempted.push(file); writeFileSync(file.path, file.after);
  }
} catch (error) {
  const failures: unknown[] = [error];
  for (const file of attempted.reverse()) {
    try { writeFileSync(file.path, file.before); } catch (restoreError) { failures.push(restoreError); }
  }
  throw new AggregateError(failures, 'Version synchronization failed; inspect any failed restoration');
}

console.log(`synced all workspace manifests and compiled version fallbacks -> ${version}`);
