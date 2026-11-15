import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');

const runtimeNeutralEntries = [
  'contracts/dist/index.js',
  'errors/dist/index.js',
  'operator-client/dist/index.js',
  'peer-client/dist/index.js',
  'platform/dist/index.js',
  'platform/dist/browser.js',
  'platform/dist/browser-homeassistant.js',
  'platform/dist/browser-knowledge.js',
  'platform/dist/browser-decision-router.js',
  'platform/dist/platform/gate/presets.js',
  'platform/dist/platform/channels/telegram/cursor-migration-data.js',
  'platform/dist/react-native.js',
  'platform/dist/expo.js',
  // /auth subpath is used by RN consumers for token helpers, must be node:-free
  'platform/dist/auth.js',
  'platform/dist/web.js',
  'platform/dist/workers.js',
  'platform/dist/operator.js',
  'transport-core/dist/index.js',
  'transport-http/dist/index.js',
  'transport-realtime/dist/index.js',
];

const disallowedPatterns = [
  /from ['"]node:/,
  /require\(['"]node:/,
  /import\(['"]node:/,
  /^\s*import ['"]node:/m,
  /from ['"]fs['"]/,
  /require\(['"]fs['"]\)/,
];

/**
 * Static Node-only imports, as they appear in emitted ESM: `import ... from 'node:x'`,
 * a `} from 'node:x'` closing a multi-line import, or a bare `import 'node:x'`.
 * Files reached through the closure are judged by these only: a string that merely
 * mentions `require("node:...")` (a worker program, a guarded dynamic import) is not an import.
 */
const staticNodeImports = [
  /^\s*(?:import|export)\b[^\n]*\bfrom\s*['"](?:node:[^'"]*|fs)['"]/m,
  /^\s*\}\s*from\s*['"](?:node:[^'"]*|fs)['"]/m,
  /^\s*import\s*['"](?:node:[^'"]*|fs)['"]/m,
];

/** Relative specifiers an emitted module imports, re-exports or dynamically imports. */
const RELATIVE_SPECIFIER = /(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Every module reached from `entry` through relative imports, with the chain
 * that reached it. The build emits one file per source file, so a Node-only
 * import in anything an entry reaches breaks the browser bundle just as one in
 * the entry itself would.
 */
export function findNodeOnlyImports(entry: string, read: (path: string) => string | undefined = defaultRead): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string }> = [{ file: entry, chain: entry }];
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const content = read(file);
    if (content === undefined) continue;
    const patterns = file === entry ? disallowedPatterns : staticNodeImports;
    if (patterns.some((pattern) => pattern.test(content))) offenders.push(chain);
    for (const match of content.matchAll(RELATIVE_SPECIFIER)) {
      queue.push({ file: resolve(dirname(file), match[1]!), chain: `${chain} -> ${match[1]!}` });
    }
  }
  return offenders;
}

function defaultRead(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

if (import.meta.main) {
  for (const relativePath of runtimeNeutralEntries) {
    const entry = resolve(ENGINE_ROOT, relativePath);
    // An entry that is missing is a broken list or an unbuilt tree, never a pass.
    if (!existsSync(entry)) throw new Error(`Runtime-neutral entry is missing (run the build first): ${relativePath}`);
    const offenders = findNodeOnlyImports(entry);
    if (offenders.length > 0) {
      throw new Error(`Runtime-neutral entry reaches a Node-only import: ${offenders.map((chain) => chain.replaceAll(`${ENGINE_ROOT}/`, '')).join('; ')}`);
    }
  }
  console.log('browser/runtime-neutral runtime-neutral support check passed');
}
