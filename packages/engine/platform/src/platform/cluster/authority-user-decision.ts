/**
 * authority-user-decision.ts, the owner's answer to a username held by separate
 * accounts made on different machines before they joined one group (owner
 * decision D2: such a name is reported, never merged silently).
 *
 * `cluster publish user:<name>` makes this machine's account the group's: every
 * other account of that name is revoked on the authority record. `cluster
 * accept user:<name>` takes the group's account here: this machine's account
 * is revoked, which leaves the other one. Either way the name has one account
 * on every machine afterwards; each machine then signs the name in with that
 * account's password, and the sign-ins of the account that was revoked end
 * there (the user store ends sessions whose password changed).
 *
 * This machine's account is the incarnation this machine wrote: while a name
 * is held by separate accounts no machine writes a change to any of them (the
 * user store keeps changes local), so each account's origin is still the
 * machine it was made on.
 */
import type { AuthorityChange, AuthorityRecordFile } from './authority-record-file.js';

export interface UserAccountDecision {
  readonly username: string;
  readonly decision: 'published' | 'accepted';
  /** Account ids revoked on the authority record. */
  readonly revoked: readonly string[];
}

/** The name is not held by separate accounts, or this machine has no account of it to keep or give up. */
export class UserAccountDecisionError extends Error {
  override readonly name = 'UserAccountDecisionError';
}

export async function decideUserAccount(file: AuthorityRecordFile, username: string, decision: 'publish' | 'accept'): Promise<UserAccountDecision> {
  const result = await file.write((view) => {
    const conflict = view.userConflicts().find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
    if (!conflict) throw new UserAccountDecisionError(`user "${username}" is not held by separate accounts on this group's machines; there is nothing to decide`);
    const mine = conflict.incarnations.filter((incarnation) => incarnation.origin === view.nodeId);
    const others = conflict.incarnations.filter((incarnation) => incarnation.origin !== view.nodeId);
    if (mine.length === 0) {
      throw new UserAccountDecisionError(`this machine holds no account of user "${username}" of its own; run the command on the machine whose account the group should keep`);
    }
    if (decision === 'accept' && others.length !== 1) {
      throw new UserAccountDecisionError(`user "${username}" is held by ${others.length} other accounts, so "the group's account" names none; on the machine whose account the group should keep, share it with the group (Devices and network, Machine group, share a setting: user:${username})`);
    }
    const revoke = decision === 'publish' ? others : mine;
    const reason = decision === 'publish' ? 'another machine\'s account of this name became the group\'s' : 'this machine took the group\'s account of this name';
    return {
      kind: 'many',
      value: revoke.map((incarnation) => incarnation.id),
      changes: revoke.map((incarnation): AuthorityChange<null> => ({ kind: 'revoke', key: `user:${incarnation.id}`, by: 'owner', reason, value: null })),
    };
  });
  return { username, decision: decision === 'publish' ? 'published' : 'accepted', revoked: result.value };
}
