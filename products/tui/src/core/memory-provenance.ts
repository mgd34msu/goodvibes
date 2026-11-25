// ---------------------------------------------------------------------------
// memory-provenance.ts, the optional "used N memories" turn chip (owner-ruled
// 2026-07-13, default OFF).
//
// The platform tags each turn payload with the memory-sourced injection ids it drew
// on: `metadata.memory.recordIds: string[]` (absent when none), the SAME
// convention the webui's chip reads, so both surfaces name the same records.
// When the memory-provenance setting is ON, a turn that used memories shows a
// small chip naming how many, with a drill-in listing them. When OFF (default),
// NOTHING is rendered and the metadata is never even read.
// ---------------------------------------------------------------------------

import type { ConfigKey, ConfigManager, HostBooleanSetting } from '@goodvibes/engine/platform/platform/config';

/** Setting key: show the per-turn memory-provenance chip. Default OFF. */
export const MEMORY_SHOW_PROVENANCE_CONFIG_KEY = 'memory.showProvenance';
export const MEMORY_SHOW_PROVENANCE_DEFAULT = false;

/**
 * Registered on the TUI's config manager (see config/host-settings.ts), so the
 * loader knows the key, Settings lists it under Memory, and every read resolves
 * to a boolean (the default when unset or malformed).
 */
export const MEMORY_SHOW_PROVENANCE_SETTING: HostBooleanSetting = Object.freeze({
  key: MEMORY_SHOW_PROVENANCE_CONFIG_KEY,
  label: 'Show which memories an answer used',
  type: 'boolean',
  default: MEMORY_SHOW_PROVENANCE_DEFAULT,
  description: 'Show a "used N memories" chip on turns that drew on your standing memories, with a drill-in '
    + 'listing them (Ctrl+G then e to expand, unless rebound). Off by default; when off, nothing is rendered and no metadata is read.',
});

/** Whether the memory-provenance chip is on. */
export function readMemoryShowProvenance(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get(MEMORY_SHOW_PROVENANCE_CONFIG_KEY as ConfigKey) === true;
}

/**
 * Extract the memory-sourced record ids a turn drew on, from the platform's
 * `metadata.memory.recordIds` convention. Structural (not a named import) so it
 * reads the field whether or not the pinned platform's TurnEvent type surfaces it
 * yet, and yields an empty list for any turn without the field, never a guess,
 * never a throw.
 */
export function memoryRecordIdsFromTurn(turn: unknown): readonly string[] {
  const metadata = (turn as { metadata?: unknown } | null | undefined)?.metadata;
  const memory = (metadata as { memory?: unknown } | null | undefined)?.memory;
  const recordIds = (memory as { recordIds?: unknown } | null | undefined)?.recordIds;
  if (!Array.isArray(recordIds)) return [];
  return recordIds.filter((id): id is string => typeof id === 'string');
}
