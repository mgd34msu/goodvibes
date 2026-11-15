import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
const PACKAGES_ROOT = resolve(ENGINE_ROOT, '..');

/**
 * The engine subpaths a browser, React Native or worker consumer imports. Each
 * is resolved through the engine's exports map, the way a consumer's bundler
 * resolves it, so a renamed or removed subpath fails here instead of passing
 * against a stale file path.
 */
const RUNTIME_NEUTRAL_SUBPATHS = [
  './contracts',
  './errors',
  './operator-client',
  './peer-client',
  './platform',
  './platform/browser',
  './platform/browser/homeassistant',
  './platform/browser/knowledge',
  './platform/browser/decision-router',
  './platform/platform/gate/presets',
  './platform/platform/channels/telegram-cursor',
  './platform/react-native',
  './platform/expo',
  // React Native consumers use the auth subpath for token helpers.
  './platform/auth',
  './platform/web',
  './platform/workers',
  './platform/operator',
  './transport-core',
  './transport-http',
  './transport-realtime',
];

/** The condition the built output is published under; the source condition is dropped at release. */
const BUILD_CONDITION = 'import';

/** One workspace package: its root directory and its exports map. */
interface WorkspacePackage {
  readonly root: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

/** Resolves a package-name specifier to a file, or reports why it cannot. */
export type PackageResolver = (specifier: string) => { readonly file: string } | { readonly error: string } | undefined;

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier);
}

/** The built target of one exports entry: its `import` condition, or the entry itself when it is a plain path. */
function buildTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const target = record[BUILD_CONDITION] ?? record['default'];
  return typeof target === 'string' ? target : undefined;
}

/** Every package under packages/, by name, so a package-name import of this workspace is followed like a relative one. */
export function workspacePackages(root: string = PACKAGES_ROOT): ReadonlyMap<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const manifestPath = join(root, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; exports?: unknown };
    if (typeof manifest.name !== 'string' || !manifest.exports || typeof manifest.exports !== 'object') continue;
    packages.set(manifest.name, { root: join(root, entry.name), exports: manifest.exports as Record<string, unknown> });
  }
  return packages;
}

/** A resolver over the workspace's exports maps; undefined for a specifier outside the workspace (a third-party dependency). */
export function exportsResolver(packages: ReadonlyMap<string, WorkspacePackage>): PackageResolver {
  return (specifier) => {
    for (const [name, pkg] of packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const key = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
      const target = buildTarget(pkg.exports[key]);
      return target === undefined
        ? { error: `${specifier} is not a key of ${name}'s exports map` }
        : { file: resolve(pkg.root, target) };
    }
    return undefined;
  };
}

/** Specifiers a module loads when it is evaluated: static imports and re-exports, including a multi-line `} from` and a bare `import 'x'`. */
const STATIC_SPECIFIERS = [
  /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*\}\s*from\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
];
/** Specifiers loaded on demand. Followed for workspace modules; a Node built-in here is allowed past the entry (a guarded dynamic import). */
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** CommonJS loads, judged in an entry file only: past it, `require("node:...")` is usually text inside a worker program. */
const REQUIRE_SPECIFIER = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(content: string, patterns: readonly RegExp[]): string[] {
  return patterns.flatMap((pattern) => [...content.matchAll(pattern)].map((match) => match[1]!));
}

/**
 * Every Node-only import reached from `entry` through relative imports and
 * through package-name imports of this workspace, each with the chain that
 * reached it. The build emits one file per source file, so a Node-only import
 * in anything an entry reaches breaks the browser bundle just as one in the
 * entry itself would. A reached file that cannot be read, or a package-name
 * import the exports map does not carry, is reported too: the walk cannot
 * vouch for what it could not see.
 */
export function findNodeOnlyImports(
  entry: string,
  read: (path: string) => string | undefined = defaultRead,
  resolvePackage: PackageResolver = () => undefined,
): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string }> = [{ file: entry, chain: entry }];
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const content = read(file);
    if (content === undefined) {
      offenders.push(`${chain} (cannot be read)`);
      continue;
    }
    const isEntry = file === entry;
    const loaded = specifiers(content, STATIC_SPECIFIERS);
    const onDemand = specifiers(content, [DYNAMIC_SPECIFIER]);
    const judged = isEntry ? [...loaded, ...onDemand, ...specifiers(content, [REQUIRE_SPECIFIER])] : loaded;
    for (const specifier of judged) {
      if (isNodeBuiltin(specifier)) offenders.push(`${chain} -> ${specifier}`);
    }
    for (const specifier of [...loaded, ...onDemand]) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push({ file: resolve(dirname(file), specifier), chain: `${chain} -> ${specifier}` });
        continue;
      }
      const resolved = resolvePackage(specifier);
      if (resolved === undefined) continue;
      if ('error' in resolved) offenders.push(`${chain} -> ${resolved.error}`);
      else queue.push({ file: resolved.file, chain: `${chain} -> ${specifier}` });
    }
  }
  return [...new Set(offenders)];
}

function defaultRead(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

if (import.meta.main) {
  const packages = workspacePackages();
  const resolvePackage = exportsResolver(packages);
  const engineName = (JSON.parse(readFileSync(join(ENGINE_ROOT, 'package.json'), 'utf8')) as { name: string }).name;
  const problems: string[] = [];
  for (const subpath of RUNTIME_NEUTRAL_SUBPATHS) {
    const specifier = subpath === '.' ? engineName : `${engineName}${subpath.slice(1)}`;
    const resolved = resolvePackage(specifier);
    if (resolved === undefined || 'error' in resolved) {
      problems.push(`${specifier}: not in the exports map`);
      continue;
    }
    // A missing entry is an unbuilt tree, never a pass.
    if (!existsSync(resolved.file)) {
      problems.push(`${specifier}: ${resolved.file.replace(`${PACKAGES_ROOT}/`, '')} is missing (run bun run build first)`);
      continue;
    }
    for (const chain of findNodeOnlyImports(resolved.file, defaultRead, resolvePackage)) {
      problems.push(`${specifier}: ${chain.replaceAll(`${PACKAGES_ROOT}/`, '')}`);
    }
  }
  if (problems.length > 0) {
    console.error(`browser/runtime-neutral check FAILED: ${problems.length} problem(s) in what browser, React Native and worker entries reach:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`browser/runtime-neutral check passed: ${RUNTIME_NEUTRAL_SUBPATHS.length} entries reach no Node-only import, following relative and workspace package imports`);
}
