import type { ConfigManager, DaemonWritePress } from '@goodvibes/engine/platform/platform/config';
import { effectivePermissionMode, gatePresetLabel, isGatePresetName } from '@goodvibes/engine/platform/platform/gate/presets';
import type { GatePresetName } from '@goodvibes/engine/platform/platform/gate';
import { describePermissionModeInForce, type ModeInForceWords, type PermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';

/** Borrow the active conversation's owner; no second configuration store. */
export interface ActiveExecutionMode {
  hostedSessionId(): string | null;
  hasHostedOwner?(): boolean;
  executionMode(): GatePresetName | undefined;
  /** When the host's mode in force differs from the session's chosen mode: the chosen mode and why. */
  executionModeDifference?(): { readonly chosen: GatePresetName; readonly reason: string; readonly words?: ModeInForceWords } | undefined;
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

/**
 * The status bar's mode words: this process's ModeInForceWords (`local`,
 * kept current by session-permission-mode.ts), or, for a hosted session, the
 * host's words for its mode in force (the mode's label when the host sent
 * none). One memory read.
 */
export function describeExecutionModeWords(
  config: Pick<ConfigManager, 'get'>,
  local: () => ModeInForceWords,
): Pick<ModeInForceWords, 'chosen' | 'inForce' | 'chosenWhen' | 'chosenShort' | 'because' | 'failure'> {
  if (!hasActiveExecutionMode(config)) return local();
  const inForce = readExecutionModeInForce(config);
  if (inForce === undefined) return { chosen: 'not reported yet' };
  if (inForce.mode === inForce.chosen) return { chosen: gatePresetLabel(inForce.mode) };
  const hostWords = owners.get(config)?.executionModeDifference?.()?.words;
  if (hostWords?.inForce !== undefined) return hostWords;
  return {
    chosen: gatePresetLabel(inForce.chosen),
    inForce: inForce.mode === 'ask-me' ? 'asking you, for now' : `${gatePresetLabel(inForce.mode)}, for now`,
    chosenShort: `you chose ${gatePresetLabel(inForce.chosen)}`,
  };
}

export async function refreshExecutionMode(config: object): Promise<void> {
  const owner = owners.get(config);
  if (owner && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null)) await owner.refreshExecutionMode?.();
}

/**
 * `press`: who decided the change, from the call site (the person's own choice of mode, or the Agent's gate on the
 * model's call); sent with the write, so a looser mode is not put to the owner as someone else's.
 */
export async function setExecutionMode(config: Pick<ConfigManager, 'get' | 'set'>, mode: unknown, press?: DaemonWritePress): Promise<void> {
  if (typeof mode !== 'string' || !isGatePresetName(mode)) throw new Error('Select an execution mode: ask-me, jev-decides, just-vibes, yolo or plan.');
  const owner = owners.get(config);
  if (owner && (owner.hasHostedOwner?.() ?? owner.hostedSessionId() !== null)) {
    await owner.setExecutionMode(mode);
    return;
  }
  config.set('permissions.mode', mode, press ? { press } : {});
}

/** Seed a newly authenticated session before it has a remote mode owner. */
export function readInitialExecutionMode(config: Pick<ConfigManager, 'get'>): GatePresetName {
  return effectivePermissionMode(config.get('permissions.mode'), config.get('behavior.autoApprove') === true);
}
