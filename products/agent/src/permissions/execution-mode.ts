import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { effectivePermissionMode, isGatePresetName, type GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate';

/** Borrow the active conversation's owner; no second configuration store. */
export interface ActiveExecutionMode {
  hostedSessionId(): string | null;
  hasHostedOwner?(): boolean;
  executionMode(): GatePresetName | undefined;
  refreshExecutionMode?(): Promise<void>;
  setExecutionMode(mode: GatePresetName): Promise<void>;
}
const owners = new WeakMap<object, ActiveExecutionMode>();

export function bindActiveExecutionMode(config: object, owner: ActiveExecutionMode): () => void {
  owners.set(config, owner);
  return () => { if (owners.get(config) === owner) owners.delete(config); };
}

export function hasActiveExecutionMode(config: object): boolean {
  const owner = owners.get(config);
  return owner !== undefined && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null);
}

export function readExecutionMode(config: Pick<ConfigManager, 'get'>): GatePresetName | undefined {
  const owner = owners.get(config);
  if (owner && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null)) return owner.executionMode();
  return readInitialExecutionMode(config);
}

export async function refreshExecutionMode(config: object): Promise<void> {
  const owner = owners.get(config);
  if (owner && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null)) await owner.refreshExecutionMode?.();
}

export async function setExecutionMode(config: Pick<ConfigManager, 'get' | 'set'>, mode: unknown): Promise<void> {
  if (typeof mode !== 'string' || !isGatePresetName(mode)) throw new Error('Select Safe owner, Safe Jev, YOLO, or Plan.');
  const owner = owners.get(config);
  if (owner && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null)) {
    await owner.setExecutionMode(mode);
    return;
  }
  config.set('permissions.mode', mode);
}

/** Seed a newly authenticated session before it has a remote mode owner. */
export function readInitialExecutionMode(config: Pick<ConfigManager, 'get'>): GatePresetName {
  return effectivePermissionMode(config.get('permissions.mode'), config.get('behavior.autoApprove') === true);
}
