/**
 * channel-profiles/store.ts
 *
 * Durable JSON-snapshot persistence for channel profile bindings, following the
 * same PersistentStore snapshot pattern the automation and principal stores use.
 *
 * One unusable row never takes the others down: every channel's intake reads
 * this file, so a row whose permission mode this build does not know keeps its
 * other fields, loses only the mode (the host default applies), is reported
 * once at load, and is listed flagged so the owner can replace or delete it.
 */
import { PersistentStore } from '../state/persistent-store.js';
import { isSettableGatePresetName, parsePermissionMode } from '../gate/presets.js';
import { logger } from '../utils/logger.js';
import { CHANNEL_PERMISSION_MODES, type ChannelProfileBinding } from './types.js';

interface ChannelProfilesSnapshot extends Record<string, unknown> {
  version: 1;
  bindings: ChannelProfileBinding[];
}

function readBinding(path: string, raw: unknown, index: number): ChannelProfileBinding | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    logger.warn('Channel profile row skipped: it is not an object', { path, index });
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.surfaceKind !== 'string' || row.id.length === 0 || row.surfaceKind.length === 0) {
    logger.warn('Channel profile row skipped: it has no id or surfaceKind, so no channel can match it', { path, index });
    return null;
  }
  const { permissionMode: mode, invalid: _ignored, ...rest } = row;
  const binding = rest as unknown as ChannelProfileBinding;
  if (mode === undefined) return binding;
  // Retired names map through the same table the settings use.
  const parsed = typeof mode === 'string' ? parsePermissionMode(mode) : undefined;
  if (parsed !== undefined && isSettableGatePresetName(parsed)) return { ...binding, permissionMode: parsed };
  const reason = `permissionMode ${JSON.stringify(mode)} is not one this build knows (${CHANNEL_PERMISSION_MODES.join(', ')}); sessions from this channel use the host default mode until the binding is set again or deleted`;
  logger.warn('Channel profile row has an unknown permission mode', { path, bindingId: binding.id, value: mode, next: 'channels.profiles.set or channels.profiles.delete for this binding' });
  return { ...binding, invalid: { field: 'permissionMode', value: mode, reason } };
}

function toStored(binding: ChannelProfileBinding): ChannelProfileBinding {
  if (!binding.invalid) return binding;
  const { invalid, ...rest } = binding;
  // Written back as found, so a value a newer build understands is not lost.
  return { ...rest, permissionMode: invalid.value } as ChannelProfileBinding;
}

export class ChannelProfileStore {
  private readonly store: PersistentStore<ChannelProfilesSnapshot>;

  constructor(private readonly path: string) {
    this.store = new PersistentStore<ChannelProfilesSnapshot>(path);
  }

  async load(): Promise<ChannelProfileBinding[]> {
    const snapshot = await this.store.load();
    if (!snapshot) return [];
    if (snapshot.version !== 1 || !Array.isArray(snapshot.bindings)) {
      throw new Error(`Channel profiles in ${this.path} are not a version 1 snapshot (found version ${JSON.stringify(snapshot.version)}), so they were not read and nothing was changed. `
        + 'If a newer build wrote the file, run that build; otherwise move the file aside and set the profiles again.');
    }
    return snapshot.bindings.flatMap((raw, index) => readBinding(this.path, raw, index) ?? []);
  }

  async save(bindings: readonly ChannelProfileBinding[]): Promise<void> {
    await this.store.persist({ version: 1, bindings: bindings.map(toStored) });
  }
}
