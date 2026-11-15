import { isCompiledBunModuleUrl } from '../utils/bun-module.js';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';

/**
 * `sqlite-vec` is an optionalDependency, resolved through `createRequire` at
 * the one call that needs it rather than imported statically, the same technique,
 * and for the same reason, as the `bun:sqlite` resolution in
 * knowledge/browser-history/readers.ts: a static import puts the specifier on
 * the module graph, and a graph that cannot link is a process that dies at
 * module init with no handler running. See utils/optional-dependency.ts.
 *
 * In a compiled binary this is never called: `resolveSqliteVecPath()` returns
 * the co-located extension and `db.loadExtension` takes that path. It is the
 * development and unbundled-runtime path that needs the package.
 */
function requireSqliteVecLoad(): (db: Database) => void {
  const mod = createRequire(import.meta.url)('sqlite-vec') as { load: (db: Database) => void };
  return mod.load;
}

/**
 * Resolves the path to the sqlite-vec native extension.
 *
 * When running inside a Bun bundled executable (import.meta.url path contains
 * "$bunfs"), the npm package's import.meta.resolve() cannot find the extension
 * because the virtual filesystem does not contain node_modules. In that case,
 * the extension must be co-located with the binary under
 * `<execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>`.
 *
 * In development (bun run / node), the package's own getLoadablePath() is used
 * via the re-exported `load()` function.
 *
 * Shared by memory-vector-store.ts (MemoryStore's vector index) and
 * code-index-store.ts (the repo source-tree code index; see CHANGELOG 0.38.0) so both
 * indexes load the exact same native extension the exact same way.
 *
 * The process facts the resolver reads are injectable so a test can stand in for a compiled binary.
 */
export interface SqliteVecPathContext {
  readonly moduleUrl?: string | undefined;
  readonly execPath?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
}

export function resolveSqliteVecPath(context: SqliteVecPathContext = {}): string {
  if (isCompiledBunModuleUrl(context.moduleUrl ?? import.meta.url)) {
    const platform = context.platform ?? process.platform;
    const os = platform === 'win32' ? 'windows' : platform;
    const arch = context.arch ?? process.arch;
    const suffix = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
    return join(dirname(context.execPath ?? process.execPath), 'lib', `sqlite-vec-${os}-${arch}`, `vec0.${suffix}`);
  }
  // In dev mode, delegate to sqlite-vec's own resolver.
  return '';
}

/**
 * Thrown when the RUNTIME PLATFORM cannot load SQLite extensions at all,
 * most commonly a macOS-compiled binary, where bun:sqlite links Apple's
 * system SQLite, which ships with extension loading disabled. This is a
 * permanent capability limit of the platform, not a defect in the build:
 * callers should degrade to their documented no-vector mode with the
 * `reason` surfaced, rather than reporting an error. A missing extension
 * FILE (a genuine packaging defect) deliberately does NOT map to this class.
 */
export class SqliteVecPlatformUnsupportedError extends Error {
  readonly platformLimit = true;

  constructor(cause: string) {
    super(
      "this platform's SQLite does not allow loading extensions"
      + ' (macOS system SQLite); the semantic vector index is unavailable'
      + ` and memory search uses literal matching. Underlying refusal: ${cause}`,
    );
    this.name = 'SqliteVecPlatformUnsupportedError';
  }
}

/**
 * The platform's refusal, once seen: extension loading is a property of the
 * SQLite library this process linked, so the second index does not try again.
 */
let platformRefusal: string | undefined;

/** SQLite's own compile options: one query on the open handle. A handle that cannot answer says nothing. */
function extensionLoadingCompiledOut(db: Database): boolean {
  try {
    const row = db.query<{ omitted: number }, []>("SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted").get();
    return Number(row?.omitted) === 1;
  } catch {
    return false;
  }
}

/** Facts the classification reads, injectable so a test can stand in for another platform. */
export interface SqliteVecLoadContext {
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * Loads the sqlite-vec extension into a Bun SQLite database.
 * Handles both bundled-binary and development execution contexts.
 *
 * Decided in code, with no model request: an extension that cannot be found
 * (no co-located file in a compiled binary, no `sqlite-vec` package in
 * development) is a packaging defect and is thrown as it is. A found extension
 * that the library refuses to load is the platform's limit when SQLite says it
 * was compiled without extension loading, or on macOS, whose system SQLite
 * (linked by a compiled binary) disables it; that throws
 * SqliteVecPlatformUnsupportedError. Anything else is rethrown untouched.
 */
export function loadSqliteVecExtension(db: Database, context: SqliteVecLoadContext = {}): void {
  if (platformRefusal !== undefined) throw new SqliteVecPlatformUnsupportedError(platformRefusal);
  const bundledPath = resolveSqliteVecPath();
  if (bundledPath && !existsSync(bundledPath)) {
    throw new Error(`the sqlite-vec extension is missing from this install (expected at ${bundledPath}); reinstall to restore semantic search.`);
  }
  const load = bundledPath ? (target: Database) => target.loadExtension(bundledPath) : requireSqliteVecLoad();
  try {
    load(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (extensionLoadingCompiledOut(db) || (context.platform ?? process.platform) === 'darwin') {
      platformRefusal = message;
      throw new SqliteVecPlatformUnsupportedError(message);
    }
    throw err;
  }
}

/** Tests forget a refusal recorded by an earlier case. */
export function forgetSqliteVecPlatformRefusal(): void {
  platformRefusal = undefined;
}
