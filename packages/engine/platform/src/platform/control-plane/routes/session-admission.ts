/**
 * routes/session-admission.ts, the one admission of a call on one session.
 *
 * A session's owners are the subject of what a call causes on it (the effect
 * table, security/effect-authority.ts): a credential below admin acts only on a
 * session it created or was shared. The hosted-session verbs, the live-turn
 * verbs and the session lists all admit through here, so they cannot disagree
 * about who may act on or read a session. A call the daemon makes in-process is
 * the program's own.
 */
import { systemActor, type Actor } from '@goodvibes/engine/daemon-api/http-policy';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { admitEffects, type EffectId } from '../../security/effect-authority.js';
import { GatewayVerbError } from './gateway-verb-error.js';

function actorOf(invocation: GatewayMethodInvocation): Actor {
  return invocation.context.actor ?? systemActor('in-process');
}

/** Admit `effects` on a session whose owners are `owners`, or throw the refusal a client can act on. */
export function admitOnSession(invocation: GatewayMethodInvocation, effects: readonly EffectId[], owners: readonly string[]): void {
  const admission = admitEffects(actorOf(invocation), effects, { owners });
  if (admission.kind === 'allowed') return;
  if (admission.kind === 'ask-owner') {
    throw new GatewayVerbError(`${admission.reason}; nothing was done.`, 'OWNER_ONLY', 403, 'sessionId');
  }
  const next = admission.code === 'NOT_YOURS'
    ? ' Ask an owner of the session to share it with you (sessions.hosted.share), or use an admin credential.'
    : ` ${admission.next}`;
  throw new GatewayVerbError(`${admission.reason} (${admission.effect}; missing ${admission.missing}); nothing was done.${next}`,
    admission.code, 403, 'sessionId');
}

/** Whether the caller may read a session's transcript (and so its record, whose title is its first prompt). */
export function mayReadSession(invocation: GatewayMethodInvocation, owners: readonly string[]): boolean {
  return admitEffects(actorOf(invocation), ['session.transcript.read'], { owners }).kind === 'allowed';
}
