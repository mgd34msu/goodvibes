/**
 * connection-party.ts, whose input an ACP connection to the owner's own program (`goodvibes acp`) carries.
 *
 * The owner's own connection (their editor launched their program) makes the session's agent their turn; a `goodvibes acp`
 * the daemon starts for anyone else (a hosted agent or a runner a device, a member or an outside caller asked for) is
 * that caller's input, so its agent runs reads only (security/turn-input-party.ts). The daemon says so in the started
 * program's environment; the mark can only tighten: present, someone else's; absent, the program decides as for its own
 * editor. Nothing reads it as the owner.
 */
import type { TurnInputParty } from '../security/turn-input-party.js';

/** Set by the daemon in the environment of a `goodvibes acp` it starts for someone other than the owner: who that is. */
export const ACP_STARTED_FOR_ENV = 'GOODVIBES_ACP_STARTED_FOR';

/**
 * The party of an ACP connection of the owner's own program: someone else's when the daemon started it for someone
 * else (the environment says who), else the owner's own.
 */
export function acpConnectionParty(env: Readonly<Record<string, string | undefined>>): TurnInputParty {
  const startedFor = env[ACP_STARTED_FOR_ENV];
  if (startedFor !== undefined) {
    const who = startedFor.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 200);
    return { party: 'other', who: who || 'a caller the daemon started this agent for' };
  }
  return { party: 'owner' };
}

/**
 * The environment a child ACP agent is started with for `party`: the daemon's own, plus the mark when the connection is
 * someone else's (a third-party agent ignores it; the owner's own program reads it). Undefined for the owner's: the
 * child inherits the environment as before.
 */
export function acpChildEnvironment(party: TurnInputParty | undefined): Record<string, string | undefined> | undefined {
  if (party?.party === 'owner') return undefined;
  return { ...process.env, [ACP_STARTED_FOR_ENV]: party?.who ?? 'a caller the daemon started this agent for' };
}
