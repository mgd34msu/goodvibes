import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A compiled product may resolve a foreign package.json. Only its own manifest may override the baked version. */
export function readProductVersion(moduleDirectory: string, packageName: string, fallback: string): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(moduleDirectory, '..', 'package.json'), 'utf8'));
    if (manifest && typeof manifest === 'object' && 'name' in manifest && manifest.name === packageName
      && 'version' in manifest && typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;
  } catch { /* A compiled binary or missing manifest uses its build's version. */ }
  return fallback;
}

export function workspaceProductUpdatePolicy(manifest: { readonly private?: boolean; readonly dependencies?: Readonly<Record<string, unknown>> }, packageName: string, label: string) {
  const isWorkspaceDistribution = manifest.private === true && manifest.dependencies?.['@goodvibes-jev/engine'] === 'workspace:*';
  const rebuildCommand = `bun run --filter ${packageName} build`;
  const guidance = `This ${label} is built from a private Jev workspace. Update the workspace and build the engine, then run ${rebuildCommand} from the workspace root.`;
  return { isWorkspaceDistribution, rebuildCommand, guidance };
}
