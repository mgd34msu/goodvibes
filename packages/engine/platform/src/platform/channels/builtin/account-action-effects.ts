import type { ChannelAccountLifecycleAction } from '../types.js';

/** What an account lifecycle action does, beside the switch that does it. */
export interface ChannelAccountActionEffect {
  /** Writes, completes or removes a surface's stored credentials (or its linked session). */
  readonly changesCredentials: boolean;
}

/**
 * Every account action and its effect. The pairs `connect`/`login` and
 * `disconnect`/`logout` run the same handlers in account-actions.ts and in the
 * plugin registry, so they carry the same effect; a new action cannot be added without an entry.
 */
export const CHANNEL_ACCOUNT_ACTION_EFFECTS: Readonly<Record<ChannelAccountLifecycleAction, ChannelAccountActionEffect>> = {
  inspect: { changesCredentials: false },
  retest: { changesCredentials: false },
  start: { changesCredentials: false },
  stop: { changesCredentials: false },
  setup: { changesCredentials: true },
  connect: { changesCredentials: true },
  login: { changesCredentials: true },
  wait_login: { changesCredentials: true },
  disconnect: { changesCredentials: true },
  logout: { changesCredentials: true },
};

/** The account action named by `value`, or null when no action has that name. */
export function readAccountLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
  return typeof value === 'string' && Object.hasOwn(CHANNEL_ACCOUNT_ACTION_EFFECTS, value)
    ? value as ChannelAccountLifecycleAction
    : null;
}
