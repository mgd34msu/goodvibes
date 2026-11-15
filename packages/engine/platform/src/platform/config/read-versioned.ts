/**
 * read-versioned.ts, the migration-aware, quarantine-on-failure reader every
 * versioned JSON file on this platform is read through, plus the bounded
 * reclaim of the quarantine files it produces.
 *
 * The contract in one line: a file this reader cannot trust is renamed aside,
 * never overwritten and never parsed into a caller's state.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * The suffix every quarantined file on this platform gets. Exported so the
 * other producer of these files (the transcript journal's corrupt-tail
 * quarantine) and the reclaim sweep below all agree on one spelling.
 */
export const UNRECOGNIZED_SUFFIX = '.unrecognized';

/**
 * A migration function that transforms data from version N to N+1.
 * Receives the raw parsed object and must return the upgraded object.
 */
export type VersionMigration = (data: Record<string, unknown>) => Record<string, unknown>;

export interface ReadVersionedOptions {
  /**
   * The version number this reader expects. When the file version equals
   * `currentVersion`, no migrations are run. When it is lower, migrations
   * are applied stepwise. When it is missing or non-numeric, `onUnknown`
   * behaviour fires. A file with a HIGHER version belongs to a newer process:
   * it is left where it is and null is returned.
   */
  readonly currentVersion: number;

  /**
   * Optional stepwise migrations indexed by the FROM version.
   * `migrations[1]` upgrades version-1 data to version-2 data.
   * Applied in ascending order until `currentVersion` is reached.
   */
  readonly migrations?: Readonly<Record<number, VersionMigration>>;

  /**
   * What to do when the file version is unrecognised (higher than
   * `currentVersion` or missing/non-numeric).
   *
   * `'quarantine'`, rename the file to `<path>.unrecognized` and return null.
   */
  readonly onUnknown: 'quarantine';
}

/**
 * Migration-aware, quarantine-on-failure versioned file reader.
 *
 * Parse flow:
 *   1. If the file does not exist → return null.
 *   2. If JSON is corrupt → quarantine to `<path>.unrecognized`, return null.
 *   3. If the version field is missing → quarantine, return null. If it is
 *      higher than currentVersion → leave the file in place, return null.
 *   4. If the version is lower than currentVersion → apply stepwise migrations.
 *      If no migration exists for a version gap, or a migration throws,
 *      quarantine and return null.
 *   5. Return the (possibly migrated) object. Callers are responsible for
 *      narrowing the returned value, this helper handles versioning and
 *      corruption only, not schema validation.
 */
export function readVersioned<T extends { version: number }>(
  path: string,
  options: ReadVersionedOptions,
): T | null {
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    quarantine(path);
    return null;
  }

  if (!isPlainObject(raw)) {
    quarantine(path);
    return null;
  }

  const fileVersion = raw['version'];
  if (typeof fileVersion !== 'number' || !Number.isFinite(fileVersion)) {
    quarantine(path);
    return null;
  }

  if (fileVersion > options.currentVersion) {
    // Produced by a newer process, and perfectly good for it: moving it aside
    // would take the newer process's state away. This reader just cannot use it.
    return null;
  }

  let data: Record<string, unknown> = raw;

  if (fileVersion < options.currentVersion) {
    const migrations = options.migrations ?? {};
    for (let v = fileVersion; v < options.currentVersion; v++) {
      const migrate = migrations[v];
      if (!migrate) {
        // No migration path for this version gap, quarantine.
        quarantine(path);
        return null;
      }
      try {
        data = migrate(data);
      } catch {
        quarantine(path);
        return null;
      }
    }
  }

  return data as T;
}

/**
 * Call before a writer replaces a versioned file in place. A file written by a
 * newer process (its version is above `currentVersion`) is renamed to the
 * quarantine name instead of being overwritten, so the newer state survives a
 * downgrade. Returns true when a file was set aside. Any other file (missing,
 * unreadable, same or older version) is left for the writer, which replaces it.
 */
export function setAsideNewerVersionFile(path: string, currentVersion: number): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return false;
  }
  if (!isPlainObject(raw)) return false;
  const fileVersion = raw['version'];
  if (typeof fileVersion !== 'number' || !Number.isFinite(fileVersion) || fileVersion <= currentVersion) return false;
  quarantine(path);
  return true;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first quarantine name not already taken, so an earlier forensic copy is never overwritten. */
function freeQuarantineName(path: string): string {
  const first = `${path}${UNRECOGNIZED_SUFFIX}`;
  if (!existsSync(first)) return first;
  for (let n = 1; n <= 1000; n++) {
    const candidate = `${path}.${n}${UNRECOGNIZED_SUFFIX}`;
    if (!existsSync(candidate)) return candidate;
  }
  return first;
}

function quarantine(path: string): void {
  try {
    renameSync(path, freeQuarantineName(path));
  } catch (error) {
    // Another process already moved it aside: nothing is left to report.
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    // The caller still gets null (the store starts from defaults), but the
    // corrupt file stays where it is, so say so rather than hide it.
    logger.warn('Could not move an unreadable file aside; it was left in place', { path, error: summarizeError(error) });
  }
}

// ─── Quarantine reclaim ───────────────────────────────────────────────────────
//
// Quarantining renames a bad file out of the way so a human can inspect it,
// and until now nothing ever removed the result, every corrupt config file
// and every torn journal tail left a `.unrecognized` file behind permanently.
// Forensic value is real, so the retention window below is deliberately long,
// but "keep forever" is a leak.

/**
 * How long a quarantined file is kept before it is reclaimed: 30 days
 * (2_592_000_000 ms). These files exist so a person can look at what went
 * wrong, so the window is a month rather than the hours-to-days retention the
 * live durability artefacts get, long enough to survive a holiday, short
 * enough that a recurring corruption cannot fill a disk.
 */
export const QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on quarantined files kept per swept directory, newest kept.
 * The age rule alone cannot bound a fast repeating corruption (a boot loop
 * quarantining the same file every restart), so a count cap runs alongside it.
 */
export const QUARANTINE_MAX_FILES_PER_DIR = 50;

export interface QuarantineReapResult {
  /** Quarantined files examined across every directory. */
  readonly scanned: number;
  /** Quarantined files deleted. */
  readonly reaped: number;
}

export interface QuarantineReapOptions {
  readonly now?: () => number;
  /** Override the age window (tests). */
  readonly maxAgeMs?: number;
  /** Override the per-directory count cap (tests). */
  readonly maxFilesPerDir?: number;
}

/**
 * Delete `.unrecognized` quarantine files that are past the retention window,
 * plus any beyond the per-directory count cap (newest kept).
 *
 * Each directory is scanned non-recursively; a missing or unreadable directory
 * contributes nothing and is not an error. Idempotent, and safe to run
 * concurrently from several processes, a file another sweeper already
 * unlinked (ENOENT) counts as reclaimed rather than failing the sweep.
 */
export function reapQuarantinedFiles(
  directories: readonly string[],
  options: QuarantineReapOptions = {},
): QuarantineReapResult {
  const now = options.now?.() ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? QUARANTINE_RETENTION_MS;
  const maxFilesPerDir = options.maxFilesPerDir ?? QUARANTINE_MAX_FILES_PER_DIR;

  let scanned = 0;
  let reaped = 0;

  for (const dir of new Set(directories)) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(UNRECOGNIZED_SUFFIX));
    } catch {
      continue;
    }
    scanned += names.length;

    const survivors: { readonly path: string; readonly mtimeMs: number }[] = [];
    for (const name of names) {
      const path = join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // Vanished under us (another sweeper), nothing left to reclaim.
        continue;
      }
      if (now - mtimeMs > maxAgeMs) {
        if (unlinkQuarantined(path)) reaped++;
        continue;
      }
      survivors.push({ path, mtimeMs });
    }

    if (survivors.length > maxFilesPerDir) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
      for (const victim of survivors.slice(0, survivors.length - maxFilesPerDir)) {
        if (unlinkQuarantined(victim.path)) reaped++;
      }
    }
  }

  return { scanned, reaped };
}

function unlinkQuarantined(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }
}
