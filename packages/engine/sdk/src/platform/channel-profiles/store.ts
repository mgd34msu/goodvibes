/**
 * channel-profiles/store.ts
 *
 * Durable JSON-snapshot persistence for channel profile bindings, following the
 * same PersistentStore snapshot pattern the automation and principal stores use.
 */
import { PersistentStore } from '../state/persistent-store.js';
import { isSettableGatePresetName, normalizePermissionMode } from '../gate/presets.js';
import type { ChannelProfileBinding } from './types.js';

interface ChannelProfilesSnapshot extends Record<string, unknown> {
  version: 1;
  bindings: ChannelProfileBinding[];
}

function defaultSnapshot(): ChannelProfilesSnapshot {
  return { version: 1, bindings: [] };
}

function validateSnapshot(snapshot: ChannelProfilesSnapshot | null): ChannelProfilesSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.bindings)) {
    throw new Error('Channel profile store snapshot is invalid.');
  }
  const bindings = snapshot.bindings.map(binding => {
    const mode = binding.permissionMode;
    if (mode === undefined) return binding;
    if (!isSettableGatePresetName(mode) && !['prompt', 'normal', 'accept-edits', 'custom', 'auto', 'allow-all'].includes(mode)) {
      throw new Error('Channel profile store permission mode is invalid.');
    }
    return { ...binding, permissionMode: normalizePermissionMode(mode) };
  });
  return { version: 1, bindings };
}

export class ChannelProfileStore {
  private readonly store: PersistentStore<ChannelProfilesSnapshot>;

  constructor(path: string) {
    this.store = new PersistentStore<ChannelProfilesSnapshot>(path);
  }

  async load(): Promise<ChannelProfileBinding[]> {
    return validateSnapshot(await this.store.load()).bindings;
  }

  async save(bindings: readonly ChannelProfileBinding[]): Promise<void> {
    await this.store.persist({ version: 1, bindings: [...bindings] });
  }
}
