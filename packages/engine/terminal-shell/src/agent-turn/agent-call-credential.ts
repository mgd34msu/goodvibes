/**
 * agent-call-credential.ts, which credential an Agent call to its host
 * presents. One rule for every Agent tool, in the Agent's own process and in a
 * turn the daemon hosts for it, so the host identifies and admits a call the
 * same way from either place:
 *
 * - A write the Agent makes for the owner to the owner's own state (profile
 *   and occasions writes, channel drafts and routing, and the schedules and
 *   jobs it creates or changes through `agent_operator_method`, which sends
 *   the job revision the host requires of such a call) presents the Agent's
 *   delegated credential (agent-delegation-credential.ts). The host reports it
 *   as credential kind `agent` and judges the call as the Agent acting for the
 *   owner. Only `agentCallConnection` switches a call to that credential.
 * - The lifecycle controls `agent_operator_action` sends (answer an approval,
 *   run, pause, resume or delete a schedule) are operator actions on the
 *   ordinary lane, and present the ordinary credential.
 * - Every other call, every read included, presents the Agent's ordinary
 *   credential for that host, resolved with the Agent's one precedence
 *   (connected-host-client.ts `resolveConnectedHost`): its pairing with the
 *   host (credential kind `device-token`), else the operator credential
 *   (credential kind `local` from the host's own machine). In a turn the
 *   daemon hosts, the same precedence runs against the daemon itself
 *   (in-process-host.ts).
 * - A call the owner makes in person (their `profile` command) or a surface makes
 *   to show them something presents the ordinary credential, whatever the method.
 *
 * Which credential, and so which credential kind, a call presents is decided
 * here and nowhere else.
 */
import { delegatedOperatorConnection, type DelegatedOperatorConnection } from './agent-delegation-credential.js';
import { isOperatorAutomationTargetMethod } from './operator-automation-target.js';
import type { CapturedOperatorConnection } from './operator-connection-owner.js';

/** Who makes a call: the Agent (a tool its model called), or the owner (their own command, or a view shown to them). */
export type AgentCallActor = 'agent' | 'owner';

/** The credential a call presents: the Agent's ordinary one for the host, or its delegated one. */
export type AgentCallCredential = 'ordinary' | 'delegated';

/**
 * The writes to the owner's own state the Agent makes on their behalf, besides
 * the automation jobs and schedules (operator-automation-target.ts). Profile
 * writes also state their provenance (`authority: "autonomous"`).
 */
const OWNER_STATE_WRITE_METHOD_IDS: ReadonlySet<string> = new Set([
  'profile.set', 'profile.append', 'profile.forget', 'profile.undo',
  'occasions.confirm', 'occasions.plans.confirm', 'occasions.remove',
  'occasions.answer', 'occasions.acknowledge', 'occasions.interview.answer',
  'occasions.interview.record', 'occasions.conflict.resolve', 'occasions.sweep',
  'channels.drafts.save', 'channels.drafts.delete', 'channels.routing.assign', 'channels.routing.delete',
  // A capability the model runs after this program's own gate admitted it: the host judges it as the Agent's, and
  // does not put it to the owner a second time (control-plane/routes/capabilities.ts).
  'capabilities.run',
]);

/** Which credential a call to `methodId` made by `actor` presents. A set lookup. */
export function agentCallCredential(methodId: string, actor: AgentCallActor): AgentCallCredential {
  return actor === 'agent' && (OWNER_STATE_WRITE_METHOD_IDS.has(methodId) || isOperatorAutomationTargetMethod(methodId))
    ? 'delegated'
    : 'ordinary';
}

/** The connection one call presents, under that rule. */
export interface AgentCallConnection {
  /** The host, transport and credential the call is sent with. */
  readonly connection: CapturedOperatorConnection;
  /** Present when the call presents the delegated credential; forget it (`forgetDelegatedCredential`) when the host rejects it. */
  readonly delegated?: DelegatedOperatorConnection | undefined;
}

/**
 * The connection a call presents: `ordinary` as resolved for it, or, for a
 * write the Agent makes for the owner, the Agent's delegated credential on the
 * same host and transport. An ordinary call costs nothing more; a delegated
 * one costs one read of the delegation store, and the first one per host one
 * mint request. Throws, naming the state and the next step, when the delegated
 * credential cannot be had; nothing is sent then.
 */
export async function agentCallConnection(ordinary: CapturedOperatorConnection, methodId: string, actor: AgentCallActor,
  homeDirectory: string, signal?: AbortSignal): Promise<AgentCallConnection> {
  if (agentCallCredential(methodId, actor) === 'ordinary') return { connection: ordinary };
  const delegated = await delegatedOperatorConnection(ordinary, homeDirectory, signal);
  return { connection: delegated, delegated };
}
