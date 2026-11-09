#!/usr/bin/env bun
/** Development overlay maintenance for external published consumers.
 * The current private monorepo uses workspace links, so link refuses it before
 * building or modifying installed packages. Status and release gates share the
 * package-root marker; historical receipts remain blocking recovery evidence.
 * Restore resets only the exact saved engine/judgment package set, preserving
 * its original receipt outside those packages until reinstall verification.
 * This tool never installs the released native application suite.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutSourceCondition } from './export-conditions.ts';
import { packageDirs } from './release-shared.ts';
import { engineOverlayMarkerPaths } from '../toolchain/src/lib/engine-overlay.ts';
import { captureExistingDirectory } from '../platform/src/platform/utils/atomic-json-store.ts';
import { fileObservationIdentity, readFileObservation } from '../platform/src/platform/utils/file-observation.ts';
import { drainOwned } from '@goodvibes-jev/judgment';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * This file's own engine checkout root. Honors GOODVIBES_WORKSPACE_PATH so tests (and
 * a consumer's alias, which sets the same env var to locate this file in the
 * first place) can override it, but defaults to self-location, this copy
 * lives INSIDE the checkout, unlike the three consumer copies it replaces,
 * so it never needs to guess a homedir path for itself.
 */
export const ENGINE_ROOT: string = process.env.GOODVIBES_WORKSPACE_PATH
  ? resolve(process.env.GOODVIBES_WORKSPACE_PATH, 'packages/engine')
  : resolve(__dirname, '..');

export interface WorkspacePackage {
  /** node_modules basename under @goodvibes-jev, e.g. "engine". */
  readonly nm: string;
  /** The package directory relative to the engine root ("." for the engine itself). */
  readonly dir: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
  readonly files?: readonly string[];
  readonly exports?: unknown;
}

function readManifest(path: string): PackageManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * The public packages this checkout releases, in release order: the engine
 * (whose subpaths are the old packages/*) and the judgment package released
 * with it. The list is the release tooling's own (release-shared.ts
 * packageDirs), so a package added to the release is overlaid with no change
 * here. A package is excluded when it is missing, private, or lacks
 * publishConfig.access:"public", as every private/internal package was.
 */
export function enumerateWorkspacePackages(engineCheckoutRoot: string): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const dir of packageDirs) {
    const pkg = readManifest(join(engineCheckoutRoot, dir, 'package.json'));
    if (!pkg?.name || pkg.private || pkg.publishConfig?.access !== 'public') continue;
    const nm = pkg.name.startsWith('@goodvibes-jev/') ? pkg.name.slice('@goodvibes-jev/'.length) : pkg.name;
    packages.push({ nm, dir });
  }
  return packages;
}

/** Read the engine pin: devDependencies first (agent bundles the engine there), then dependencies. */
export function readEnginePin(consumerRoot: string): string | undefined {
  const pkg = JSON.parse(readFileSync(join(consumerRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return pkg.devDependencies?.['@goodvibes-jev/engine'] ?? pkg.dependencies?.['@goodvibes-jev/engine'];
}

export interface OverlayStatus {
  readonly active: boolean;
  readonly line: string;
  readonly exitCode: number;
}

/**
 * Decide the `status` output purely from inputs: the marker file contents
 * (null when absent) and the installed package version. Overlay active →
 * exit 2; clean npm state → exit 0. Extracted so the three lifecycle states
 * are testable without a real engine build or node_modules mutation.
 */
export function overlayStatus(markerRaw: string | null, installedVersion: string | undefined): OverlayStatus {
  if (markerRaw !== null) {
    let m: { engineGit?: string; sdkGit?: string; overlaidAt?: string; sourcePath?: string } = {};
    try { const parsed: unknown = JSON.parse(markerRaw); if (parsed !== null && typeof parsed === 'object') m = parsed; } catch { /* Unreadable evidence is active, never clean. */ }
    return {
      active: true,
      line: `engine-dev: OVERLAY ACTIVE, ${m.engineGit ?? m.sdkGit ?? 'unrecognized receipt'}, overlaid ${m.overlaidAt} from ${m.sourcePath}`,
      exitCode: 2,
    };
  }
  return {
    active: false,
    line: `engine-dev: clean, npm @goodvibes-jev/engine@${installedVersion} installed.`,
    exitCode: 0,
  };
}

/** After a restore reinstall, the reinstalled version must equal the pin. Returns an issue string or null. */
export function restoreVersionIssue(restoredVersion: string | undefined, pinned: string | undefined): string | null {
  return typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned) || restoredVersion !== pinned
    ? `restored version ${String(restoredVersion)} does not match pinned ${String(pinned)}`
    : null;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function fail(msg: string): never {
  console.error(`engine-dev: ${msg}`);
  process.exit(1);
}

/**
 * Overlay one released package into a consumer's node_modules: every entry
 * of its `files` list present in the checkout (each old package's dist, the
 * contract artifacts, README, LICENSE) and its package.json as a release
 * publishes it. MUST unlink every destination before copying, see the
 * cache-safety note in the file header. Returns false when the package is not
 * installed in this consumer, or not built in the engine (a `files` dist
 * directory is missing): skip, not every consumer depends on every package.
 */
export function overlayPackage(consumerRoot: string, engineCheckoutRoot: string, pkg: WorkspacePackage): boolean {
  const installed = join(consumerRoot, 'node_modules/@goodvibes-jev', pkg.nm);
  const packageRoot = join(engineCheckoutRoot, pkg.dir);
  const manifest = readManifest(join(packageRoot, 'package.json'));
  if (!existsSync(installed) || manifest === null) return false;
  const published = manifest.files ?? [];
  const distDirs = published.filter((entry) => basename(entry) === 'dist');
  if (distDirs.length === 0 || distDirs.some((entry) => !existsSync(join(packageRoot, entry)))) return false;
  for (const entry of published) {
    const source = join(packageRoot, entry);
    if (!existsSync(source)) continue;
    rmSync(join(installed, entry), { recursive: true, force: true });
    cpSync(source, join(installed, entry), { recursive: true });
  }
  rmSync(join(installed, 'package.json'), { force: true });
  writeFileSync(
    join(installed, 'package.json'),
    `${JSON.stringify({ ...manifest, exports: withoutSourceCondition(manifest.exports) }, null, 2)}\n`,
  );
  return true;
}

export function markerPath(consumerRoot: string): string {
  return join(consumerRoot, engineOverlayMarkerPaths('@goodvibes-jev/engine')[0]!);
}

async function link(consumerRoot: string, engineCheckoutRoot: string): Promise<void> {
  if (!existsSync(engineCheckoutRoot)) fail(`local engine checkout not found at ${engineCheckoutRoot} (set GOODVIBES_WORKSPACE_PATH to override)`);
  const installedPlatformPkg = join(consumerRoot, 'node_modules/@goodvibes-jev/engine');
  if (!existsSync(installedPlatformPkg)) fail('node_modules/@goodvibes-jev/engine missing, run bun install first');

  const packages = enumerateWorkspacePackages(engineCheckoutRoot);
  if (!packages.some(pkg => pkg.nm === 'engine')) fail('This private workspace uses native workspace links; no published engine overlay is available or needed.');
  if (packages.some(pkg => pkg.nm !== 'engine' && pkg.nm !== 'judgment')) fail('Unrecognized overlay package set; no installed files changed.');
  if (existingOverlayMarkers(consumerRoot).length > 0) fail('Existing overlay evidence must be restored before linking again.');
  const installed = lstatSync(installedPlatformPkg);
  if (!installed.isDirectory() || installed.isSymbolicLink()) fail('Workspace or aliased engine installations cannot be overlaid.');
  const installedOwner = captureExistingDirectory(installedPlatformPkg);
  const sha = sh('git rev-parse --short HEAD', engineCheckoutRoot);
  const branch = sh('git rev-parse --abbrev-ref HEAD', engineCheckoutRoot);
  const dirty = sh('git status --porcelain', engineCheckoutRoot) ? 'dirty' : 'clean';

  console.log(`engine-dev: building local engine (${branch}@${sha}, ${dirty} tree)...`);
  // NOT wrapped in an extra workspace lock here: scripts/build.ts already
  // acquires the engine's own build lock internally (withWorkspaceLock('build',
  // ...)). Locking again around this execSync call would be a SEPARATE
  // acquisition in the parent process racing the child's own acquisition of
  // the SAME lock directory, a deadlock, not extra safety. Two consumers
  // linking concurrently still serialize correctly through build.ts's lock.
  // npm scripts live in the repo root package.json, two levels above the engine.
  execSync('bun run build && bun run prepare:engine', { cwd: resolve(engineCheckoutRoot, '../..'), stdio: 'inherit' });
  installedOwner.assertCurrent();
  if (!existsSync(join(engineCheckoutRoot, 'platform/dist'))) fail('Engine build produced no dist at platform/dist');

  const eligible = packages.filter(pkg => existsSync(join(consumerRoot, 'node_modules/@goodvibes-jev', pkg.nm)));
  const owners = eligible.map(pkg => {
    const path = join(consumerRoot, 'node_modules/@goodvibes-jev', pkg.nm), stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace or aliased packages cannot be overlaid.');
    return captureExistingDirectory(path);
  });
  // Publication precedes the first package replacement: a partial failed copy
  // must remain visible to every release gate and precisely resettable.
  const { createReleaseStage } = await import('../toolchain/src/lib/release-publication.ts');
  installedOwner.assertCurrent(); for (const owner of owners) owner.assertCurrent();
  const stage = createReleaseStage(installedOwner.canonical, '.engine-overlay-marker-');
  try { stage.publishBytes('.local-engine-overlay.json', Buffer.from(JSON.stringify({
    schema: 1, sourcePath: engineCheckoutRoot, engineGit: `${branch}@${sha} (${dirty})`,
    overlaidAt: new Date().toISOString(), overlaidPackages: eligible.map(pkg => pkg.nm),
    note: 'Original package reset set; an interrupted overlay may be partial. Run engine-dev restore before releasing.',
  }, null, 2)), 0o600); } finally { stage.cleanup(); }
  const overlaid: string[] = [];
  for (const [index, pkg] of eligible.entries()) {
    installedOwner.assertCurrent(); owners[index]!.assertCurrent();
    if (!overlayPackage(consumerRoot, engineCheckoutRoot, pkg)) throw new Error(`Package ${pkg.nm} could not be overlaid; saved reset receipt retained.`);
    overlaid.push(pkg.nm);
  }
  if (!overlaid.includes('engine')) fail('engine overlay failed, is node_modules populated?');
  console.log(`engine-dev: overlaid ${overlaid.length} package(s): ${overlaid.join(', ')}`);

  console.log(`engine-dev: LINKED, ${branch}@${sha} (${dirty}) now overlaid into this repo.`);
  console.log('engine-dev: run `bun scripts/engine-dev.ts restore` to return to the pinned npm version.');
}

function status(consumerRoot: string): number {
  const markers = existingOverlayMarkers(consumerRoot);
  let markerRaw: string | null = null;
  if (markers.length > 0) {
    try { markerRaw = readFileSync(markers[0]!, 'utf8'); } catch { markerRaw = '{}'; }
  }
  const installedPkgJson = join(consumerRoot, 'node_modules/@goodvibes-jev/engine/package.json');
  const installedVersion = existsSync(installedPkgJson)
    ? (JSON.parse(readFileSync(installedPkgJson, 'utf8')) as { version?: string }).version
    : undefined;
  const result = overlayStatus(markerRaw, installedVersion);
  console.log(result.line);
  return result.exitCode;
}

function existingOverlayMarkers(consumerRoot: string): string[] {
  return engineOverlayMarkerPaths('@goodvibes-jev/engine').map(path => join(consumerRoot, path)).filter(path => {
    try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  });
}

/** Reset only the exact saved package set. Keep the original receipt outside
 * packages being reinstalled, so failed installs remain visible/retryable.
 * The callback is a synchronous construction seam for inert fixture installs. */
export async function restoreEngineOverlay(consumerRoot: string, reinstall: (root: string) => void = root => {
  execSync('bun install', { cwd: root, stdio: 'inherit' });
}): Promise<void> {
  const markers = existingOverlayMarkers(consumerRoot);
  if (markers.length === 0) { console.log('engine-dev: no overlay active; nothing to restore.'); return; }
  if (markers.length !== 1) throw new Error('Multiple overlay receipts require inspection; original evidence and packages preserved.');
  const marker = markers[0]!, rootOwner = captureExistingDirectory(consumerRoot), parent = captureExistingDirectory(dirname(marker));
  const source = readFileObservation(marker);
  if (source.bytes.length > 64 * 1024) throw new Error('Overlay receipt is unavailable; original evidence preserved.');
  const markerStat = lstatSync(marker);
  if (process.geteuid && markerStat.uid !== process.geteuid()) throw new Error('Overlay receipt is not owned by this user; evidence preserved.');
  let receipt: unknown;
  try { receipt = JSON.parse(source.bytes.toString('utf8')); }
  catch { throw new Error('Overlay receipt is unavailable; original evidence preserved.'); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Overlay receipt is unavailable; original evidence preserved.');
  const raw = receipt as Record<string, unknown>, names = raw.overlaidPackages;
  if (raw.schema !== undefined && raw.schema !== 1 || !Array.isArray(names) || names.length < 1 || names.length > 2
    || names.some(value => value !== 'engine' && value !== 'judgment') || new Set(names).size !== names.length || !names.includes('engine')) {
    throw new Error('Unrecognized overlay receipt; original evidence and package directories preserved.');
  }
  const manifestPath = join(consumerRoot, 'package.json'), requestManifest = readFileObservation(manifestPath);
  const pinned = readEnginePin(consumerRoot);
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) throw new Error('Overlay restore needs an exact published engine pin; workspace links and original evidence preserved.');
  const currentRequest = () => {
    rootOwner.assertCurrent();
    const request = readFileObservation(manifestPath);
    if (request.physical !== requestManifest.physical || !request.bytes.equals(requestManifest.bytes)) throw new Error('Original package pin changed; overlay evidence preserved.');
  };
  const currentSource = () => {
    currentRequest(); parent.assertCurrent();
    if (fileObservationIdentity(marker) !== source.physical) throw new Error('Original overlay receipt changed; evidence preserved.');
    const current = readFileObservation(marker);
    if (current.physical !== source.physical || !current.bytes.equals(source.bytes)) throw new Error('Original overlay receipt changed; evidence preserved.');
  };
  currentSource();
  const selected = ['engine', 'judgment'].filter(name => names.includes(name)).flatMap(name => {
    const path = join(consumerRoot, 'node_modules/@goodvibes-jev', name);
    let stat; try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Aliased/workspace package cannot be removed by overlay restore; original evidence preserved.');
    const manifest = readManifest(join(path, 'package.json'));
    if (manifest?.name !== `@goodvibes-jev/${name}` || manifest.private === true) throw new Error('Original overlaid package is unavailable; evidence preserved.');
    return [{ path, owner: captureExistingDirectory(path) }];
  });
  currentSource(); for (const item of selected) item.owner.assertCurrent();
  const recoveryPath = join(consumerRoot, '.engine-overlay-restore.json');
  const resuming = marker === recoveryPath;
  const { createReleaseStage } = await import('../toolchain/src/lib/release-publication.ts');
  currentSource(); for (const item of selected) item.owner.assertCurrent();
  let backup: { assertCurrent(): void; removeOwned(): void };
  if (resuming) {
    backup = { assertCurrent: currentSource, removeOwned() { currentSource(); rmSync(recoveryPath); } };
  } else {
    const stage = createReleaseStage(consumerRoot, '.engine-overlay-receipt-');
    try { backup = stage.publishBytes('.engine-overlay-restore.json', source.bytes, 0o600); }
    finally { stage.cleanup(); }
  }
  let changed = false;
  try {
    currentSource(); backup.assertCurrent();
    for (const item of selected) {
      currentRequest(); backup.assertCurrent(); item.owner.assertCurrent();
      changed = true;
      rmSync(item.owner.canonical, { recursive: true });
    }
    currentRequest(); backup.assertCurrent();
    const result: unknown = reinstall(consumerRoot);
    if (result !== undefined) { drainOwned(result); throw new Error('Overlay reinstall callback must finish synchronously.'); }
    currentRequest(); backup.assertCurrent();
    if (existingOverlayMarkers(consumerRoot).some(path => path !== recoveryPath)) throw new Error('Reinstalled engine still has overlay evidence.');
    const restoredEngine = readManifest(join(consumerRoot, 'node_modules/@goodvibes-jev/engine/package.json'));
    if (restoredEngine?.name !== '@goodvibes-jev/engine') throw new Error('The saved engine package has not been reinstalled.');
    const installedVersion = restoredEngine.version;
    const issue = restoreVersionIssue(typeof installedVersion === 'string' ? installedVersion : undefined, pinned);
    if (issue) throw new Error(issue);
    if (names.includes('judgment') && readManifest(join(consumerRoot, 'node_modules/@goodvibes-jev/judgment/package.json'))?.name !== '@goodvibes-jev/judgment') {
      throw new Error('The saved judgment package has not been reinstalled.');
    }
    backup.removeOwned();
    console.log(`engine-dev: RESTORED, npm @goodvibes-jev/engine@${installedVersion}.`);
  } catch (error) {
    let retained = recoveryPath;
    if (!changed && !resuming) {
      try { currentSource(); backup.removeOwned(); retained = marker; }
      catch { /* The original may have changed: retain its exact recovery copy. */ }
    }
    throw new Error(`Overlay restore did not finish; original receipt retained at ${retained}.`, { cause: error });
  }
}

async function restore(consumerRoot: string): Promise<void> { await restoreEngineOverlay(consumerRoot); }

/**
 * Entry point a consumer's alias calls directly (in-process; this file is
 * dynamically resolved and its CLI dispatch driven from here rather than
 * relying on import.meta.main, which would be false when imported). Also
 * used by this file's own `if (import.meta.main)` block below when the engine
 * repo invokes it directly. Returns the process exit code; callers decide
 * whether to actually exit (this file's own CLI block does).
 */
export async function runEngineDev(argv: readonly string[], consumerRoot: string): Promise<number> {
  const cmd = argv[0];
  if (cmd === 'link') {
    await link(consumerRoot, ENGINE_ROOT);
    return 0;
  }
  if (cmd === 'status') {
    return status(consumerRoot);
  }
  if (cmd === 'restore') {
    await restore(consumerRoot);
    return 0;
  }
  console.log('usage: bun scripts/engine-dev.ts <link|status|restore>');
  return cmd ? 1 : 0;
}

if (import.meta.main) {
  const code = await runEngineDev(process.argv.slice(2), process.cwd());
  process.exit(code);
}
