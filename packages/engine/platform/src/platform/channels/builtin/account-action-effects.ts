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
  setup: { changesCredentials: true },
  retest: { changesCredentials: false },
  connect: { changesCredentials: true },
  disconnect: { changesCredentials: true },
  start: { changesCredentials: false },
  stop: { changesCredentials: false },
  login: { changesCredentials: true },
  logout: { changesCredentials: true },
  wait_login: { changesCredentials: true },
};

/** Every account action name, in the order schemas and messages list them. */
export const CHANNEL_ACCOUNT_LIFECYCLE_ACTIONS = Object.freeze(
  Object.keys(CHANNEL_ACCOUNT_ACTION_EFFECTS) as ChannelAccountLifecycleAction[],
);

/** The account action named by `value`, or null when no action has that name. */
export function readAccountLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
  return typeof value === 'string' && Object.hasOwn(CHANNEL_ACCOUNT_ACTION_EFFECTS, value)
    ? value as ChannelAccountLifecycleAction
    : null;
}
