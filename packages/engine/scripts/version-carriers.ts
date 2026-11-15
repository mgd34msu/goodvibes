/**
 * Every file that carries the release version, in one place: the sync script
 * writes them and the consistency check reads them, so the two cannot drift
 * apart. Paths are relative to the repository root.
 */

/** Compiled fallbacks: `let <declaration> = '<version>';` in a source file. */
export const VERSION_FALLBACKS = [
  { path: 'packages/engine/platform/src/platform/version.ts', declaration: 'version' },
  { path: 'products/daemon/src/version.ts', declaration: '_version' },
  { path: 'products/tui/src/version.ts', declaration: '_version' },
  { path: 'products/agent/src/version.ts', declaration: '_version' },
] as const;

/** Workspace manifests that share the root version. */
export const VERSIONED_WORKSPACES = [
  'packages/engine', 'packages/judgment', 'products/daemon', 'products/tui', 'products/agent', 'products/webui',
] as const;

export function fallbackPattern(declaration: string): RegExp {
  return new RegExp(`^let ${declaration} = ['"][^'"\\r\\n]*['"];+$`, 'gm');
}

/** The version a compiled fallback declares, or undefined unless there is exactly one declaration. */
export function readFallbackVersion(source: string, declaration: string): string | undefined {
  const matches = [...source.matchAll(fallbackPattern(declaration))];
  if (matches.length !== 1) return undefined;
  return /['"]([^'"\r\n]*)['"]/.exec(matches[0]![0])?.[1];
}
