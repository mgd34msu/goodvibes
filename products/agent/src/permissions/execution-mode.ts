import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { effectivePermissionMode, isGatePresetName } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import type { GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate';
import { describePermissionModeInForce, type PermissionModeInForce } from '@goodvibes-jev/engine/platform/platform/permissions';

/** Borrow the active conversation's owner; no second configuration store. */
export interface ActiveExecutionMode {
  hostedSessionId(): string | null;
  hasHostedOwner?(): boolean;
  executionMode(): GatePresetName | undefined;
  /** When the host's mode in force differs from the session's chosen mode: the chosen mode and why. */
  executionModeDifference?(): { readonly chosen: GatePresetName; readonly reason: string } | undefined;
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

/**
 * The mode in force for this conversation, the mode chosen, and why they
 * differ: the host's account for a hosted session, else read from this
 * process's settings the way its gate reads them.
 */
export function readExecutionModeInForce(config: Pick<ConfigManager, 'get'>): PermissionModeInForce | undefined {
  const owner = owners.get(config);
  if (owner && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null)) {
    const mode = owner.executionMode();
    if (mode === undefined) return undefined;
    const difference = owner.executionModeDifference?.();
    return difference ? { chosen: difference.chosen, mode, reason: difference.reason } : { chosen: mode, mode };
  }
  return describePermissionModeInForce(config);
}

export async function refreshExecutionMode(config: object): Promise<void> {
  const owner = owners.get(config);
  if (owner && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null)) await owner.refreshExecutionMode?.();
}

export async function setExecutionMode(config: Pick<ConfigManager, 'get' | 'set'>, mode: unknown): Promise<void> {
  if (typeof mode !== 'string' || !isGatePresetName(mode)) throw new Error('Select an execution mode: ask-me, jev-decides, just-vibes, yolo or plan.');
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
