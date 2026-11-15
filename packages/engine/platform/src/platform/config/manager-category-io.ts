/**
 * manager-category-io.ts, whole-category patch/remove persistence.
 *
 * Split out of manager.ts (line cap). These two operations exist for the config
 * fields that cannot be expressed as a scalar dot-path (arrays, open maps), and
 * they have to respect key ownership for the same reason `set` does: a category
 * patch that wrote `surfaces.*` into a surface silo would re-create exactly the
 * duplication the daemon config migration removes.
 */

import { readRawSettingsFile } from './settings-io.js';
import { isDaemonOwnedConfigKey } from './config-ownership.js';
import { persistDaemonKey, removeDaemonKey } from './daemon-config-tier.js';
import { readDotPath } from './shared-config-tier.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface CategoryIoDeps {
  readonly configPath: string;
  readonly daemonTierPath: string | null;
  readonly writeRawGlobal: (raw: Record<string, unknown>) => void;
  readonly markDaemonKey: (key: string, present: boolean) => void;
}

/**
 * Shallow-merge `patch` into the on-disk representation of `categoryName`.
 * Daemon-owned leaves are routed to the daemon store instead of the surface
 * file. Returns nothing; `live` is the caller's staged copy, published only if
 * this returns. The patch spans two files, so a failure on the surface write
 * puts the daemon keys already written back: a settings change either lands in
 * both or in neither.
 */
export function persistCategoryPatch(
  categoryName: string,
  patch: Record<string, unknown>,
  live: Record<string, unknown>,
  deps: CategoryIoDeps,
): void {
  const raw = readRawSettingsFile(deps.configPath);
  let rawCategory = raw[categoryName];
  if (rawCategory === null || typeof rawCategory !== 'object' || Array.isArray(rawCategory)) {
    rawCategory = {};
    raw[categoryName] = rawCategory;
  }
  const rawCat = rawCategory as Record<string, unknown>;
  const daemonWrites: { dotted: string; previous: { present: boolean; value: unknown } }[] = [];
  const undoDaemonWrites = (): void => {
    if (!deps.daemonTierPath) return;
    for (const { dotted, previous } of daemonWrites.reverse()) {
      try {
        if (previous.present) persistDaemonKey(deps.daemonTierPath, dotted, previous.value);
        else removeDaemonKey(deps.daemonTierPath, dotted);
      } catch (error) {
        logger.warn(`Could not restore daemon setting ${dotted} after a failed category write: ${summarizeError(error)}`);
      }
    }
  };
  try {
    // Only the patched keys reach disk, the category's defaults are never frozen in.
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) continue;
      live[key] = patch[key];
      const dotted = `${categoryName}.${key}`;
      if (deps.daemonTierPath && isDaemonOwnedConfigKey(dotted)) {
        const previous = readDotPath(readRawSettingsFile(deps.daemonTierPath), dotted);
        persistDaemonKey(deps.daemonTierPath, dotted, patch[key]);
        daemonWrites.push({ dotted, previous: { present: previous.present, value: previous.value } });
        deps.markDaemonKey(dotted, true);
        continue;
      }
      rawCat[key] = patch[key];
    }
    if (Object.keys(rawCat).length === 0) delete raw[categoryName];
    deps.writeRawGlobal(raw);
  } catch (error) {
    undoDaemonWrites();
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
    removeDaemonKey(deps.daemonTierPath, dotted);
    deps.markDaemonKey(dotted, false);
    return;
  }
  const raw = readRawSettingsFile(deps.configPath);
  const rawCategory = raw[categoryName];
  if (rawCategory !== null && typeof rawCategory === 'object' && !Array.isArray(rawCategory)) {
    const rawCat = rawCategory as Record<string, unknown>;
    delete rawCat[key];
    if (Object.keys(rawCat).length === 0) delete raw[categoryName];
  }
  deps.writeRawGlobal(raw);
}
