/**
 * daemon-home.ts
 *
 * Resolves and manages the daemon's identity home directory (`daemon.homeDir`).
 *
 * The daemon home holds immutable-after-startup identity state:
 *   - auth-users.json
 *   - auth-bootstrap.txt
 *   - daemon-settings.json
 *   - operator-tokens.json
 *
 * Resolution order (first match wins):
 *   1. --daemon-home=<path> CLI arg (passed as daemonHomeArg)
 *   2. GOODVIBES_DAEMON_HOME environment variable
 *   3. <tree root>/.goodvibes/daemon/, the tree root being what
 *      `GOODVIBES_HOME` names, falling back to the login home.
 *
 * That third step used to call `homedir()` directly, which is the defect this
 * header now records. `GOODVIBES_HOME` relocates the tree root for every other
 * part of the platform (settings, workspace state, every secret tier, see
 * config/goodvibes-home.ts), so a daemon started under a redirected root kept
 * its identity files, auth users, operator tokens, daemon settings, in the
 * REAL `~/.goodvibes/daemon`. A relocation one resolver ignores is not a
 * relocation; the tree root is resolved in exactly one place now and this
 * module derives from it rather than recomputing a home of its own.
 *
 * The daemon home is canonical. Startup creates it when absent, but does not
 * import identity state from other surfaces or workspace-scoped paths.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '../config/goodvibes-home.js';
import { operatorTokenPath } from '../pairing/companion-token.js';
import { logger } from '../utils/logger.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { withProcessLockSync } from '../utils/process-lock.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DaemonHomeDirs {
  /** Absolute path to the daemon home directory (immutable identity state). */
  readonly daemonHomeDir: string;
  /** True if this startup created the daemon home directory. */
  readonly freshInstall: boolean;
}

export interface DaemonHomeOptions {
  /** Value of --daemon-home CLI flag, if provided. */
  readonly daemonHomeArg?: string | undefined;
  /** Override process.env for testing. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the daemon home directory from CLI flag, environment variable, or the
 * tree root.
 *
 * The explicit `--daemon-home` argument wins outright because it names THIS
 * process's identity directory and nothing else. Everything below it is the
 * platform's one home resolution: `GOODVIBES_DAEMON_HOME` names the identity
 * directory specifically, and absent that the directory falls under the tree
 * root `GOODVIBES_HOME` names, so a redirected tree takes its daemon identity
 * with it instead of reaching back into the login home.
 */
export function resolveDaemonHomeDir(options: DaemonHomeOptions = {}): string {
  const env = options.env ?? process.env;

  // 1. CLI arg, names this directory outright, above both env vars.
  if (options.daemonHomeArg) {
    const p = options.daemonHomeArg.trim();
    if (p) return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
  }

  // 2/3. GOODVIBES_DAEMON_HOME, else <tree root>/.goodvibes/daemon.
  return resolveGoodVibesDaemonHome(resolveGoodVibesHome(env), env);
}

// ---------------------------------------------------------------------------
// Global operator token path
// ---------------------------------------------------------------------------

// The token file's path is stated once, beside its only writer.
export { operatorTokenPath } from '../pairing/companion-token.js';

// ---------------------------------------------------------------------------
// Daemon home creation
// ---------------------------------------------------------------------------

/**
 * Create the daemon home directory if it does not already exist.
 *
 * Returns `freshInstall: true` when the directory was created, `false` when it
 * already existed.
 */
export function ensureDaemonHome(daemonHomeDir: string): DaemonHomeDirs {
  const alreadyExists = existsSync(daemonHomeDir);

  if (alreadyExists) {
    return { daemonHomeDir, freshInstall: false };
  }

  // Owner-only: the directory holds identity and pairing state.
  mkdirSync(daemonHomeDir, { recursive: true, mode: 0o700 });
  return { daemonHomeDir, freshInstall: true };
}

// ---------------------------------------------------------------------------
// Operator token file read, daemon settings write
// ---------------------------------------------------------------------------

/**
 * Read operator tokens from the global daemon-home path.
 * Returns undefined when the file does not exist or cannot be parsed.
 */
export function readOperatorTokenFile(daemonHomeDir: string): string | undefined {
  const tokenPath = operatorTokenPath(daemonHomeDir);
  if (!existsSync(tokenPath)) return undefined;
  try {
    return readFileSync(tokenPath, 'utf-8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Daemon settings persistence
// ---------------------------------------------------------------------------

/**
 * Read a single key from daemon-settings.json, or return undefined if missing.
 */
export function readDaemonSetting(daemonHomeDir: string, key: string): string | undefined {
  const settingsPath = join(daemonHomeDir, 'daemon-settings.json');
  if (!existsSync(settingsPath)) return undefined;
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const val = parsed[key]!;
    return typeof val === 'string' ? val : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a single key into daemon-settings.json (merge, not replace).
 *
 * Through the one atomic writer, durably (file and directory synced before it
 * returns), at 0600: the file holds pairing state, and a power loss must not
 * leave it empty. The read-merge-write runs under the file's process lock so
 * two processes setting different keys keep both.
 */
export function writeDaemonSetting(daemonHomeDir: string, key: string, value: string): void {
  const settingsPath = join(daemonHomeDir, 'daemon-settings.json');
  mkdirSync(daemonHomeDir, { recursive: true, mode: 0o700 });
  withProcessLockSync(`${settingsPath}.writer.sqlite`, () => {
    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      } catch (err: unknown) {
        // Keep the unreadable bytes: the file may hold other keys (pairing
        // state) that an operator can still recover. If they cannot be set
        // aside, refuse the write rather than destroy them.
        const aside = `${settingsPath}.corrupt-${Date.now()}`;
        renameSync(settingsPath, aside);
        logger.warn('[DaemonHome] daemon-settings.json could not be parsed; it was moved aside and a fresh file is being written', {
          path: settingsPath,
          movedTo: aside,
          error: String(err),
        });
      }
    }
    writeJsonFileAtomic(settingsPath, { ...existing, [key]: value }, { mode: 0o600, durable: true, trailingNewline: false });
  });
}
