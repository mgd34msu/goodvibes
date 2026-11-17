import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutSourceCondition } from './export-conditions.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ENGINE_ROOT = resolve(__dirname, '..');
export const REPO_ROOT = resolve(ENGINE_ROOT, '../..');
// The repo root .tmp, as before: the stage copies the engine, so it cannot sit inside it.
const ENGINE_TEMP_ROOT = resolve(REPO_ROOT, '.tmp');
// The engine is one package: every old workspace package is a subpath of it.
// The judgment package it depends on is released with it, so a packed engine
// always has the judgment tarball it resolves `@goodvibes-jev/judgment` to.
// Dirs are relative to the engine root. Order is publish order: a package is
// listed after every package it depends on, so a publish that stops part-way
// can never leave the engine on the registry pointing at a missing judgment version.
export const packageDirs = ['../judgment', '.'];

export const publicPackageDirs = packageDirs;

export interface PackageManifest extends Record<string, unknown> {
  name?: string;
  version?: string;
  files?: readonly string[];
  repository?: unknown;
  // `| undefined` is load-bearing under exactOptionalPropertyTypes: the
  // normalizers below deliberately assign undefined to drop a dependency group
  // from the staged manifest (JSON.stringify omits it), and that is not the same
  // as the property being absent from the type.
  dependencies?: Record<string, unknown> | undefined;
  devDependencies?: Record<string, unknown> | undefined;
  peerDependencies?: Record<string, unknown> | undefined;
  optionalDependencies?: Record<string, unknown> | undefined;
}

export interface PackageStage {
  readonly dir: string;
  readonly sourceDir: string;
  readonly stageDir: string;
  readonly manifest: PackageManifest;
}

export interface RunOptions {
  readonly auth?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly registry?: string;
  readonly packageName?: string;
  readonly stdio?: 'inherit' | 'pipe' | 'ignore';
  readonly encoding?: BufferEncoding;
  readonly maxBuffer?: number;
  /**
   * When provided along with `auth: true`, the caller-supplied AuthEnv is used
   * instead of creating a new one. Allows the caller to track and clean up
   * the temp npmrc directory via cleanupAuthEnv().
   */
  readonly authEnv?: AuthEnv;
}

export function getRootPackage(): PackageManifest {
  return JSON.parse(readFileSync(resolve(ENGINE_ROOT, 'package.json'), 'utf8'));
}

export function getRootVersion(): string {
  const version = getRootPackage().version;
  if (typeof version !== 'string') throw new Error('Root package version must be a string.');
  return version;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function getPackageDirectoryPath(dir: string): string {
  return resolve(ENGINE_ROOT, dir);
}

export function getPackageJsonPath(dir: string): string {
  return resolve(getPackageDirectoryPath(dir), 'package.json');
}

export function readPackage(dir: string): PackageManifest {
  const value = readJson(getPackageJsonPath(dir));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Package JSON is not an object: ${dir}`);
  return value as PackageManifest;
}

export function getPublishRegistryOverride(): string | null {
  const value = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim();
  if (!value) return null;
  const registry = value.replace(/\/+$/, '');
  assertAllowedPublishRegistry(registry);
  return registry;
}

function assertAllowedPublishRegistry(registry: string): void {
  const hostname = getRegistryHostname(registry);
  if (hostname === 'registry.npmjs.org' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return;
  }
  throw new Error(
    `Unsupported publish registry host: ${hostname}. Publish overrides are limited to npmjs.org or loopback test registries.`,
  );
}

/** The package's name, read from its manifest. */
export function packageNameForDir(dir: string): string {
  const name = readPackage(dir).name;
  if (typeof name !== 'string' || !name) throw new Error(`Package ${dir} is missing a string name.`);
  return name;
}

/** Where a package is copied inside a release stage: one directory per package, named after its source directory. */
function stageDirName(dir: string): string {
  return basename(getPackageDirectoryPath(dir));
}

export function isPublicPackageDir(dir: string): boolean {
  return publicPackageDirs.includes(dir);
}

function shouldCopyPath(path: string): boolean {
  const parts = path.split('/');
  return (
    // The engine's own scratch directories are not package content.
    !path.startsWith(resolve(ENGINE_ROOT, '.tmp')) &&
    !path.startsWith(resolve(ENGINE_ROOT, '.test-tmp')) &&
    !parts.some((p) => p === 'node_modules' || p === '.git' || p === 'coverage') &&
    !path.endsWith('.tsbuildinfo')
  );
}

function stagePlatformSecurityMitigationAssets(stageDir: string): void {
  const vendorDir = resolve(stageDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  rmSync(resolve(vendorDir, 'bash-language-server'), { recursive: true, force: true });
  cpSync(
    resolve(REPO_ROOT, 'vendor/bash-language-server'),
    resolve(vendorDir, 'bash-language-server'),
    { recursive: true },
  );
}

function normalizeDependencyGroup(group: unknown, rootVersion: string): Record<string, unknown> | undefined {
  // A manifest dependency group is an object or absent, so returning undefined
  // for anything else is the same value the previous `return group` produced.
  if (!group || typeof group !== 'object') {
    return undefined;
  }
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(group)) {
    next[name] = typeof value === 'string' && value.startsWith('workspace:')
      ? rootVersion
      : value;
  }
  return next;
}

function addUniqueFiles(files: unknown, entries: readonly string[]): readonly string[] {
  const next = Array.isArray(files)
    ? files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  for (const entry of entries) {
    if (!next.includes(entry)) next.push(entry);
  }
  return next;
}

export function applyPlatformVendorMitigations(manifest: PackageManifest): PackageManifest {
  // npm links an embedded file: directory without installing that directory's
  // own dependencies. Declare the vendored Bash package's leaves at the real
  // installable engine layer. Its version-conflicting zod/tree-sitter leaves
  // use explicit aliases in both runtime and declaration imports.
  const bashManifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'vendor/bash-language-server/package.json'), 'utf8')) as PackageManifest;
  const optionalDependencies = { ...(manifest.optionalDependencies ?? {}) };
  for (const [name, version] of Object.entries(bashManifest.dependencies ?? {})) {
    for (const existing of [manifest.dependencies?.[name], optionalDependencies[name]]) {
      if (existing !== undefined && existing !== version) {
        throw new Error(`Vendored Bash dependency ${name}=${String(version)} conflicts with engine ${String(existing)}; use an explicit alias`);
      }
    }
    if (manifest.dependencies?.[name] === undefined) optionalDependencies[name] = version;
  }
  return {
    ...manifest,
    dependencies: omitPackageName(manifest.dependencies, 'bash-language-server'),
    optionalDependencies: {
      ...optionalDependencies,
      'bash-language-server': 'file:vendor/bash-language-server',
    },
    files: addUniqueFiles(manifest.files, [
      'vendor/bash-language-server',
    ]),
  };
}

function omitPackageName(group: unknown, name: string): Record<string, unknown> | undefined {
  if (!group || typeof group !== 'object') return undefined;
  const next: Record<string, unknown> = Object.fromEntries(
    Object.entries(group).filter(([entry]) => entry !== name),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeRepository(repository: unknown): unknown {
  if (!repository || typeof repository !== 'object' || typeof (repository as { readonly url?: unknown }).url !== 'string') {
    return repository;
  }
  const record = repository as Record<string, unknown> & { readonly url: string };
  const url = record.url.startsWith('git+')
    ? record.url
    : record.url.endsWith('.git')
      ? `git+${record.url}`
      : `git+${record.url}.git`;
  return { ...record, url };
}

export function normalizeManifest(pkg: PackageManifest, rootVersion = getRootVersion()): PackageManifest {
  return {
    ...pkg,
    repository: normalizeRepository(pkg.repository),
    // The source condition names files the package does not ship.
    exports: withoutSourceCondition(pkg.exports),
    dependencies: normalizeDependencyGroup(pkg.dependencies, rootVersion),
    devDependencies: normalizeDependencyGroup(pkg.devDependencies, rootVersion),
    peerDependencies: normalizeDependencyGroup(pkg.peerDependencies, rootVersion),
    optionalDependencies: normalizeDependencyGroup(pkg.optionalDependencies, rootVersion),
  };
}

export function createPlatformTempDir(prefix: string): string {
  mkdirSync(ENGINE_TEMP_ROOT, { recursive: true });
  return mkdtempSync(join(ENGINE_TEMP_ROOT, prefix));
}

/**
 * Every public package is released at the root version: the engine's
 * `workspace:` dependency on judgment is rewritten to that version, so a
 * judgment manifest at another version would be published first and leave the
 * engine on the registry pointing at a judgment version that does not exist.
 * Registry versions cannot be unpublished; refuse before the first publish.
 */
export function assertStagesAtRootVersion(stages: readonly Pick<PackageStage, 'dir' | 'manifest'>[], rootVersion: string): void {
  const off = stages.filter((stage) => stage.manifest.version !== rootVersion);
  if (off.length === 0) return;
  throw new Error(
    `Refusing to publish: every public package must be at the root version ${rootVersion}, but `
    + `${off.map((stage) => `${stage.manifest.name ?? stage.dir} is at ${String(stage.manifest.version)}`).join(', ')}. `
    + 'Run `bun run sync:version` and `bun run version:check`, then re-cut the release.',
  );
}

export async function stagePackages(): Promise<{ readonly tempRoot: string; readonly stages: readonly PackageStage[]; readonly publicStages: readonly PackageStage[] }> {
  return withWorkspaceLock('stage packages', () => {
    const rootVersion = getRootVersion();
    const tempRoot = createPlatformTempDir('goodvibes-release-');
    const stages: PackageStage[] = [];
    for (const dir of packageDirs) {
      const sourceDir = getPackageDirectoryPath(dir);
      const stageDir = resolve(tempRoot, stageDirName(dir));
      cpSync(sourceDir, stageDir, { recursive: true, filter: shouldCopyPath });
      if (dir === '.') {
        stagePlatformSecurityMitigationAssets(stageDir);
      }
      const manifest = normalizeManifest(readPackage(dir), rootVersion);
      if (dir === '.') {
        Object.assign(manifest, applyPlatformVendorMitigations(manifest));
      }
      writeFileSync(resolve(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      stages.push({ dir, sourceDir, stageDir, manifest });
    }
    const publicStages = stages.filter((stage) => publicPackageDirs.includes(stage.dir));
    return { tempRoot, stages, publicStages };
  });
}

export function cleanupStage(tempRoot: string): void {
  rmSync(tempRoot, { recursive: true, force: true });
}

/**
 * Names a release stage that is already staged and packed (validate makes one
 * for its pack, publint and install-smoke steps), so each of those checks
 * reads it instead of copying and packing every package again. Unset, each
 * check stages its own and removes it.
 */
export const SHARED_RELEASE_STAGE_ENV = 'GOODVIBES_RELEASE_STAGE';
const PACKED_STAGE_FILE = 'packed-stage.json';

/** A release stage with every public package packed. */
export interface PackedReleaseStage {
  readonly tempRoot: string;
  readonly publicStages: readonly PackageStage[];
  /** One tarball per public stage, in the same order. */
  readonly tarballs: readonly string[];
}

/** Stage every package and pack the public ones; the caller removes it with `cleanupStage(tempRoot)`. */
export async function createPackedReleaseStage(): Promise<PackedReleaseStage> {
  const { tempRoot, publicStages } = await stagePackages();
  try {
    const packDestination = resolve(tempRoot, 'packed');
    mkdirSync(packDestination, { recursive: true });
    const tarballs = collectTarballs(publicStages.map((stage) => packStage(stage.stageDir, packDestination)), packDestination);
    const packed: PackedReleaseStage = { tempRoot, publicStages, tarballs };
    writeFileSync(resolve(tempRoot, PACKED_STAGE_FILE), `${JSON.stringify(packed)}\n`);
    return packed;
  } catch (error) {
    cleanupStage(tempRoot);
    throw error;
  }
}

/** The packed stage `GOODVIBES_RELEASE_STAGE` names, or null when none is shared. */
export function sharedPackedReleaseStage(): PackedReleaseStage | null {
  const root = process.env[SHARED_RELEASE_STAGE_ENV];
  if (!root) return null;
  return JSON.parse(readFileSync(resolve(root, PACKED_STAGE_FILE), 'utf8')) as PackedReleaseStage;
}

/**
 * The shared packed stage when one is named, else a fresh one this process
 * owns. `release` removes only a stage this call made.
 */
export async function acquirePackedReleaseStage(): Promise<{ readonly stage: PackedReleaseStage; release(): void }> {
  const shared = sharedPackedReleaseStage();
  if (shared) return { stage: shared, release: () => {} };
  const stage = await createPackedReleaseStage();
  return { stage, release: () => cleanupStage(stage.tempRoot) };
}

export function getRegistryHost(registryUrl: string): string {
  const normalized = (registryUrl || 'https://registry.npmjs.org').replace(/\/+$/, '');
  return new URL(normalized).host;
}

function getRegistryHostname(registryUrl: string): string {
  const normalized = (registryUrl || 'https://registry.npmjs.org').replace(/\/+$/, '');
  return new URL(normalized).hostname;
}

export function getAuthToken(
  registryUrl = 'https://registry.npmjs.org',
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  assertAllowedPublishRegistry(registryUrl);
  return env.NODE_AUTH_TOKEN || env.NPM_TOKEN || null;
}

function getPackageScope(packageName: unknown): string | null {
  if (typeof packageName !== 'string' || !packageName.startsWith('@')) {
    return null;
  }
  const slashIndex = packageName.indexOf('/');
  return slashIndex > 1 ? packageName.slice(0, slashIndex) : null;
}

export interface AuthEnv {
  /** The full process environment including auth token and npmrc config path. */
  readonly env: NodeJS.ProcessEnv;
  /** Absolute path to the temp npmrc directory created by createAuthEnv, or undefined if no token. */
  readonly tempDir?: string;
}

export function createAuthEnv(extraEnv: NodeJS.ProcessEnv = {}, options: { readonly registry?: string; readonly packageName?: string } = {}): AuthEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const registry = options.registry || 'https://registry.npmjs.org';
  const token = getAuthToken(registry, merged);
  if (!token) {
    return { env: merged };
  }
  const registryHost = getRegistryHost(registry);
  const npmrcTempDir = createPlatformTempDir('goodvibes-npmrc-');
  const userConfigPath = resolve(npmrcTempDir, '.npmrc');
  const npmrcLines = [`//${registryHost}/:_authToken=${token}`];
  const scope = getPackageScope(options.packageName);
  if (scope && registryHost !== 'registry.npmjs.org') {
    npmrcLines.push(`${scope}:registry=${registry}`);
  }
  // The file holds the publish token: readable by this user only, whatever the umask or the directory mode.
  writeFileSync(userConfigPath, `${npmrcLines.join('\n')}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...merged,
    NODE_AUTH_TOKEN: token,
    NPM_CONFIG_USERCONFIG: userConfigPath,
  };
  return { env, tempDir: npmrcTempDir };
}

export function cleanupAuthEnv(authEnv: AuthEnv): void {
  if (authEnv.tempDir) {
    rmSync(authEnv.tempDir, { recursive: true, force: true });
  }
}

// Security note: `command` and `args` are hardcoded caller-controlled literals ('npm', 'tar', 'node').
// `process.env` is inherited unfiltered. If process.env contains an attacker-controlled NODE_OPTIONS,
// NODE_PATH, npm_config_*, or PATH, the child process will inherit it. This is acceptable for
// developer-facing release tooling (not a public API), but callers must not pass untrusted env.
export function run(command: string, args: readonly string[], cwd: string, options: RunOptions = {}): string {
  const ownedAuthEnv = options.auth && !options.authEnv
    ? createAuthEnv(options.env, {
      ...(options.registry !== undefined ? { registry: options.registry } : {}),
      ...(options.packageName !== undefined ? { packageName: options.packageName } : {}),
    })
    : undefined;
  const childEnv = options.auth
    ? (options.authEnv?.env ?? ownedAuthEnv!.env)
    : { ...process.env, ...options.env };
  try {
    return execFileSync(command, args, {
      cwd,
      env: childEnv,
      stdio: options.stdio ?? 'inherit',
      encoding: options.encoding ?? 'utf8',
      ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    });
  } finally {
    if (ownedAuthEnv) cleanupAuthEnv(ownedAuthEnv);
  }
}

/**
 * npm wrappers (version-manager shims, "npm notice" lines) sometimes print plain
 * text on stdout alongside the JSON document, and that text can itself contain
 * brackets ("[notice] ...", "[1/3] ..."). Yield each balanced bracketed span in
 * order so the caller keeps the first one that is the report, tracking string
 * literals so braces inside paths do not confuse the depth count.
 */
function* jsonCandidates(raw: string): Generator<string> {
  let from = 0;
  for (;;) {
    const start = raw.slice(from).search(/[[{]/);
    if (start < 0) return;
    const first = from + start;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = first; index < raw.length && end < 0; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) end = index;
      }
    }
    if (end < 0) {
      from = first + 1;
      continue;
    }
    yield raw.slice(first, end + 1);
    from = end + 1;
  }
}

function looksLikePackResult(value: unknown): value is { readonly filename: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof (value as { filename?: unknown }).filename === 'string';
}

/**
 * npm has emitted `npm pack --json` in more than one shape:
 * - npm 10/11 emit an ARRAY: `[{ filename, files, ... }]`
 * - npm 12 emits an OBJECT keyed by package name: `{ "<name>": { filename, ... } }`
 *
 * Reading `[0]` off the object form yields undefined and fails later with an
 * opaque `result.filename` error, so accept every shape explicitly.
 */
export function selectPackResult(parsed: unknown): { readonly filename: string } | undefined {
  if (Array.isArray(parsed)) return parsed.find(looksLikePackResult);
  if (looksLikePackResult(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    return Object.values(parsed as Record<string, unknown>).find(looksLikePackResult);
  }
  return undefined;
}

export function parseNpmPackJson(raw: string): { readonly filename: string } {
  let sawCandidate = false;
  let firstParseError: string | undefined;
  for (const candidate of jsonCandidates(raw)) {
    sawCandidate = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      firstParseError ??= error instanceof Error ? error.message : String(error);
      continue;
    }
    const result = selectPackResult(parsed);
    if (result) return result;
  }
  if (!sawCandidate) {
    throw new Error(`npm pack --json printed no JSON document; npm emitted: ${raw.trim().slice(0, 400)}`);
  }
  if (firstParseError !== undefined) {
    throw new Error(`npm pack --json printed JSON that could not be parsed (${firstParseError}); npm emitted: ${raw.trim().slice(0, 400)}`);
  }
  throw new Error(
    `npm pack --json returned an unrecognized JSON shape; expected an array of pack results or an object keyed by package name, but npm emitted: ${raw.trim().slice(0, 400)}`,
  );
}

export function packStage(stageDir: string, packDestination: string): { readonly filename: string } {
  const output = run(
    'npm',
    ['pack', '--json', '--pack-destination', packDestination],
    stageDir,
    // npm includes every packed file in its JSON; the engine's listing exceeds
    // execFileSync's default 1 MiB. Keep the complete document within the same
    // finite budget as the tarball inspection helpers below.
    { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
  );
  return parseNpmPackJson(output);
}

export function inspectPackedManifest(tarballPath: string): PackageManifest {
  return JSON.parse(
    execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

export function listPackedFiles(tarballPath: string): string[] {
  return execFileSync('tar', ['-tf', tarballPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readPackedText(tarballPath: string, entryPath: string): string {
  return execFileSync('tar', ['-xOf', tarballPath, entryPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

export function collectTarballs(packResults: readonly { readonly filename: string }[], packDestination: string): string[] {
  return packResults.map((result) => resolve(packDestination, result.filename));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assertChangelogSection(version: string, label: string): void {
  const changelogPath = resolve(ENGINE_ROOT, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const headerPattern = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`, 'm');
  if (headerPattern.test(changelog)) return;
  throw new Error(
    `[${label}] RELEASE BLOCKED: CHANGELOG.md is missing a section for v${version}.\n\n` +
    `  Add a section before publishing:\n\n` +
    `    ## [${version}] - YYYY-MM-DD\n` +
    `    ### Breaking\n` +
    `    ### Added\n` +
    `    ### Fixed\n` +
    `    ### Migration\n\n` +
    `  See docs/release-and-publishing.md for the Changelog Gate requirements.`,
  );
}
