/**
 * channel-profiles/types.ts
 *
 * The per-channel profile binding model. A channel (a surface kind, optionally
 * narrowed to one channel/account id within it) can bind a profile, the
 * model/provider and permission-mode defaults applied to sessions that channel
 * ORIGINATES (inbound messages turned into sessions). This is the model+
 * permission "profile" the ProfileManager deliberately does not carry
 * (ProfileData excludes permissions), scoped to a channel rather than the host.
 */

import { SESSION_GATE_PRESET_NAMES, type SettableGatePresetName } from '../gate/presets.js';

/** A channel uses the same execution modes as a live session. */
export type ChannelPermissionMode = SettableGatePresetName;
export const CHANNEL_PERMISSION_MODES = SESSION_GATE_PRESET_NAMES;

/**
 * One channel→profile binding. `surfaceKind` is required; `channelId` narrows
 * the binding to a single channel/account within that surface (e.g. one Slack
 * channel). A binding with no `channelId` is the surface-wide default.
 */
export interface ChannelProfileBinding {
  readonly id: string;
  readonly surfaceKind: string;
  readonly channelId?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly permissionMode?: ChannelPermissionMode | undefined;
  readonly updatedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** The subset of a binding that actually enriches an originated session/spawn. */
export interface ChannelProfileDefaults {
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly permissionMode?: ChannelPermissionMode | undefined;
}

export type ChannelProfileErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND';

export class ChannelProfileError extends Error {
  readonly code: ChannelProfileErrorCode;
  constructor(message: string, code: ChannelProfileErrorCode) {
    super(message);
    this.name = 'ChannelProfileError';
    this.code = code;
  }
}

/** The deterministic id of a binding for a (surfaceKind, channelId?) key. */
export function channelProfileBindingId(surfaceKind: string, channelId?: string): string {
  const surface = surfaceKind.trim().toLowerCase();
  const channel = (channelId ?? '').trim();
  return channel ? `${surface}:${channel}` : surface;
}
