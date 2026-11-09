/**
 * engine-pin-gate, verifies a consumer repo pins the engine correctly.
 *
 * Absorbs three parallel copies: tui/scripts/publish-check.ts (pin in
 * `dependencies`), agent/scripts/engine-release-gates.ts (pin in
 * `devDependencies`), and webui/scripts/release-gate.ts (adds the exports-map
 * import sweep). The tri-agreement (pin ⇄ lockfile ⇄ installed) catches the
 * "pin bumped but lockfile lagged, ships old engine silently" failure class.
 */

import type { FsReader } from './effects.js';
import { type EnginePinConfig, resolveEnginePinConfig } from '../config.js';
import { engineOverlayMarkerPaths } from './engine-overlay.js';

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
/** A dependency on the engine through the monorepo workspace (`workspace:*`, `workspace:^`). */
const WORKSPACE_PIN = /^workspace:/;

/** One gate outcome; ok=false carries a human-readable reason. */
export interface GateResult {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Manifest {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly exports?: unknown;
}

function readManifest(fs: FsReader, path: string): Manifest {
  return JSON.parse(fs.readText(path)) as Manifest;
}

/** Read the engine pin from the configured manifest group. */
export function readEnginePin(fs: FsReader, config: EnginePinConfig): string | null {
  const manifest = readManifest(fs, 'package.json');
  const group = config.pinSource === 'devDependencies' ? manifest.devDependencies : manifest.dependencies;
  const pin = group?.[config.enginePackage];
  return typeof pin === 'string' ? pin : null;
}

/** The path a relative specifier lands on, from the importing file, normalized; may start with `..`. */
function resolveRelative(fromFile: string, specifier: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * Whether a resolved path is inside the engine's source: under
 * `packages/engine`, under an old `goodvibes` checkout, or, when it leaves
 * the consumer's root, in a sibling `engine` package.
 */
function landsInEngine(resolved: string): boolean {
  const segments = resolved.split('/');
  if (segments.includes('goodvibes')) return true;
  if (segments.some((segment, index) => segment === 'packages' && segments[index + 1] === 'engine')) return true;
  const firstInside = segments.findIndex((segment) => segment !== '..');
  return firstInside > 0 && segments[firstInside] === 'engine';
}

/**
 * Import specifiers that reach the engine: the package name itself, or a
 * relative path that resolves into the engine's source, which bypasses the
 * published entry points. Relative specifiers are resolved against the
 * importing file rather than matched as text, so `../engine/platform` from a
 * sibling package counts as well as `../../packages/engine/platform`.
 */
function collectImportSpecifiers(fs: FsReader, roots: readonly string[], enginePackage: string): string[] {
  const pattern = /(?:from\s+|require\(|import\()\s*['"]([^'"]+)['"]/g;
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: readonly string[];
    try {
      entries = fs.readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry}`;
      if (fs.isDirectory(path)) {
        walk(path);
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        const text = fs.readText(path);
        for (const match of text.matchAll(pattern)) {
          const specifier = match[1];
          if (specifier === undefined) continue;
          const reachesEngine = specifier.startsWith('.')
            ? landsInEngine(resolveRelative(path, specifier))
            : specifier === enginePackage || specifier.startsWith(`${enginePackage}/`);
          if (reachesEngine) found.push(specifier);
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/** Build the set of allowed import specifiers from the installed engine's exports map. */
function allowedExportSpecifiers(fs: FsReader, enginePackage: string): Set<string> | null {
  const installed = `node_modules/${enginePackage}/package.json`;
  if (!fs.exists(installed)) return null;
  const manifest = readManifest(fs, installed);
  if (!manifest.exports || typeof manifest.exports !== 'object') return new Set([enginePackage]);
  const allow = new Set<string>();
  for (const key of Object.keys(manifest.exports as Record<string, unknown>)) {
    if (key === '.') allow.add(enginePackage);
    else if (key.startsWith('./')) allow.add(`${enginePackage}/${key.slice(2)}`);
  }
  allow.add(enginePackage);
  return allow;
}

/**
 * Run every engine-pin gate and return one result per gate. Pure over the injected
 * FsReader, no process exit, no console. The bin maps results to exit codes.
 */
export function runEnginePinGate(fs: FsReader, partial: Partial<EnginePinConfig> | undefined): GateResult[] {
  const config = resolveEnginePinConfig(partial);
  const results: GateResult[] = [];

  const overlayPresent = engineOverlayMarkerPaths(config.enginePackage, config.overlayMarker).find(path => fs.exists(path));
  results.push({
    id: 'local-engine-overlay-absent',
    ok: !overlayPresent,
    detail: overlayPresent
      ? `dev-link overlay marker present at ${overlayPresent}, restore the published engine before cutting`
      : 'no dev-link overlay marker',
  });

  const pin = readEnginePin(fs, config);
  const pinExact = pin !== null && EXACT_SEMVER.test(pin);
  const pinWorkspace = pin !== null && WORKSPACE_PIN.test(pin);
  results.push({
    id: 'engine-pin-exact-semver',
    ok: pinExact || pinWorkspace,
    detail: pinExact || pinWorkspace
      ? `${config.enginePackage} pinned to ${pin}`
      : `${config.enginePackage} pin in ${config.pinSource} must be exact X.Y.Z or a workspace dependency (found: ${pin ?? 'missing'})`,
  });

  if (pinWorkspace) {
    // A workspace dependency has no version to match: the gate is that the
    // installed package is the workspace link and the lockfile records it so.
    const installedPath = `node_modules/${config.enginePackage}/package.json`;
    results.push({
      id: 'installed-matches-pin',
      ok: fs.exists(installedPath),
      detail: fs.exists(installedPath)
        ? `${config.enginePackage} is installed from the workspace`
        : `${config.enginePackage} is not installed (run install)`,
    });
    const lockResolves = fs.exists(config.lockfile) && fs.readText(config.lockfile).includes(`${config.enginePackage}@workspace:`);
    results.push({
      id: 'lockfile-resolves-pin',
      ok: lockResolves,
      detail: lockResolves
        ? `${config.lockfile} resolves ${config.enginePackage} from the workspace`
        : `${config.lockfile} does not resolve ${config.enginePackage} from the workspace (run install)`,
    });
  }

  if (pinExact && pin) {
    const installedPath = `node_modules/${config.enginePackage}/package.json`;
    const installedVersion = fs.exists(installedPath)
      ? (readManifest(fs, installedPath) as { version?: string }).version ?? null
      : null;
    results.push({
      id: 'installed-matches-pin',
      ok: installedVersion === pin,
      detail: installedVersion === pin
        ? `installed ${config.enginePackage}@${installedVersion} matches pin`
        : `installed ${config.enginePackage}@${installedVersion ?? 'missing'} != pin ${pin} (run install)`,
    });

    const lockPresent = fs.exists(config.lockfile);
    const lockResolves = lockPresent && fs.readText(config.lockfile).includes(`${config.enginePackage}@${pin}`);
    results.push({
      id: 'lockfile-resolves-pin',
      ok: lockResolves,
      detail: lockResolves
        ? `${config.lockfile} resolves ${config.enginePackage}@${pin}`
        : `${config.lockfile} does not resolve ${config.enginePackage}@${pin}, lockfile lagged the pin bump`,
    });
  }

  const specifiers = collectImportSpecifiers(fs, config.sourceRoots, config.enginePackage);
  const nonNpm = specifiers.filter((s) => !s.startsWith(config.enginePackage));
  results.push({
    id: 'npm-specifier-only-imports',
    ok: nonNpm.length === 0,
    detail: nonNpm.length === 0
      ? 'all engine imports use the npm specifier'
      : `non-npm engine import(s): ${[...new Set(nonNpm)].join(', ')}`,
  });

  if (config.enforceExportsMap) {
    const allow = allowedExportSpecifiers(fs, config.enginePackage);
    if (allow === null) {
      results.push({
        id: 'exports-map-only-imports',
        ok: true,
        detail: 'installed engine package.json absent, exports-map check skipped',
      });
    } else {
      const offenders = specifiers.filter((s) => s.startsWith(config.enginePackage) && !allow.has(s));
      results.push({
        id: 'exports-map-only-imports',
        ok: offenders.length === 0,
        detail: offenders.length === 0
          ? 'all engine subpath imports resolve to a published exports key'
          : `engine import(s) not in the published exports map: ${[...new Set(offenders)].join(', ')}`,
      });
    }
  }

  return results;
}
