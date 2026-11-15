/**
 * manager-category-io.ts, whole-category patch/remove persistence.
 *
 * Split out of manager.ts (line cap). These two operations exist for the config
 * fields that cannot be expressed as a scalar dot-path (arrays, open maps), and
 * they have to respect key ownership for the same reason `set` does: a category
 * patch that wrote `surfaces.*` into a surface silo would re-create exactly the
 * duplication the daemon config migration removes.
 */

import { isDaemonOwnedConfigKey } from './config-ownership.js';
import { deleteRawDotPath, writeRawDotPath } from './settings-io.js';
import { readDotPath } from './shared-config-tier.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface CategoryIoDeps {
  readonly configPath: string;
  readonly daemonTierPath: string | null;
  /** The manager's one settings-file writer (lock, read, change, atomic write). */
  readonly update: (path: string, mutate: (raw: Record<string, unknown>) => boolean | void) => Record<string, unknown>;
  readonly markDaemonKey: (key: string, present: boolean) => void;
}

/**
 * Shallow-merge `patch` into the on-disk representation of `categoryName`.
 * Daemon-owned leaves are routed to the daemon store instead of the surface
 * file, in one write. Returns nothing; `live` is the caller's staged copy,
 * published only if this returns. The patch spans two files, so a failure on
 * the surface write puts the daemon keys already written back: a settings
 * change either lands in both or in neither.
 */
export function persistCategoryPatch(
  categoryName: string,
  patch: Record<string, unknown>,
  live: Record<string, unknown>,
  deps: CategoryIoDeps,
): void {
  const daemonKeys: string[] = [];
  const surfaceKeys: string[] = [];
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue;
    const dotted = `${categoryName}.${key}`;
    if (deps.daemonTierPath && isDaemonOwnedConfigKey(dotted)) daemonKeys.push(key);
    else surfaceKeys.push(key);
  }
  const previous = new Map<string, { present: boolean; value: unknown }>();
  if (deps.daemonTierPath && daemonKeys.length > 0) {
    deps.update(deps.daemonTierPath, raw => {
      for (const key of daemonKeys) {
        const dotted = `${categoryName}.${key}`;
        const found = readDotPath(raw, dotted);
        previous.set(dotted, { present: found.present, value: found.value });
        writeRawDotPath(raw, dotted, patch[key]);
      }
    });
    for (const key of daemonKeys) { live[key] = patch[key]; deps.markDaemonKey(`${categoryName}.${key}`, true); }
  }
  try {
    // Only the patched keys reach disk, the category's defaults are never frozen in.
    deps.update(deps.configPath, raw => {
      let rawCategory = raw[categoryName];
      if (rawCategory === null || typeof rawCategory !== 'object' || Array.isArray(rawCategory)) {
        rawCategory = {};
        raw[categoryName] = rawCategory;
      }
      const rawCat = rawCategory as Record<string, unknown>;
      for (const key of surfaceKeys) rawCat[key] = patch[key];
      if (Object.keys(rawCat).length === 0) delete raw[categoryName];
    });
    for (const key of surfaceKeys) live[key] = patch[key];
  } catch (error) {
    if (deps.daemonTierPath && previous.size > 0) {
      try {
        deps.update(deps.daemonTierPath, raw => {
          for (const [dotted, before] of previous) {
            if (before.present) writeRawDotPath(raw, dotted, before.value);
            else deleteRawDotPath(raw, dotted);
          }
        });
      } catch (undoError) {
        logger.warn(`Could not restore daemon settings ${[...previous.keys()].join(', ')} after a failed category write: ${summarizeError(undoError)}`);
      }
    }
    throw error;
  }
}

/** Remove one key from a category's on-disk representation (or the daemon store). */
export function persistCategoryKeyRemoval(
  categoryName: string,
  key: string,
  deps: CategoryIoDeps,
): void {
  const dotted = `${categoryName}.${key}`;
  if (deps.daemonTierPath && isDaemonOwnedConfigKey(dotted)) {
    deps.update(deps.daemonTierPath, raw => deleteRawDotPath(raw, dotted));
    deps.markDaemonKey(dotted, false);
    return;
  }
  deps.update(deps.configPath, raw => {
    const rawCategory = raw[categoryName];
    if (rawCategory !== null && typeof rawCategory === 'object' && !Array.isArray(rawCategory)) {
      const rawCat = rawCategory as Record<string, unknown>;
      delete rawCat[key];
      if (Object.keys(rawCat).length === 0) delete raw[categoryName];
    }
  });
}
