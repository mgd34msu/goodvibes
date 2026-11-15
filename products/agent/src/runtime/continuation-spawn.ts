/**
 * continuation-spawn.ts, how an inbound shared-session follow-up is answered
 * from this Agent: handed to the daemon to host when it can be, otherwise spawned
 * here with the platform's one spawn decision (`buildContinuationSpawnInput`).
 */
import { buildContinuationSpawnInput, type ContinuationSpawnDeps } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import type { SharedSessionContinuationRequest } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { heldDispositionForUnconfirmedHandoff, type HostedConversationHandoff } from './client/hosted-handoff.ts';

export type { ContinuationSpawnDeps };

export interface HostedContinuationDeps {
  readonly hostedHandoff: Pick<HostedConversationHandoff, 'promote'>;
  readonly spawn: (input: Parameters<AgentManager['spawn']>[0]) => { readonly id: string };
  readonly spawnDeps: ContinuationSpawnDeps;
  readonly log: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * Hand-to-hosting, tried before anything is spawned here. Promoted: the daemon's
 * hosted session has the message and nothing runs locally. An unconfirmed hand-off
 * holds the message, because the daemon may already be answering it and a local
 * agent would answer it a second time on the channel. Any definite refusal falls
 * back to the local answer.
 */
export async function runHostedContinuation(
  request: Pick<SharedSessionContinuationRequest, 'task' | 'input' | 'routeBinding'>,
  deps: HostedContinuationDeps,
): Promise<
  | { readonly disposition: 'transferred'; readonly requestId: string }
  | { readonly disposition: 'held'; readonly reason: string }
  | { readonly agentId: string }
> {
  const { task, input, routeBinding } = request;
  const handoff = await deps.hostedHandoff.promote({
    sessionId: input.sessionId,
    task,
    body: input.body,
    ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
  if (handoff.promoted) {
    // No local agent ran, so a reply must not bind to an agent id that does not exist.
    return { disposition: 'transferred', requestId: handoff.hostedSessionId };
  }
  const hold = heldDispositionForUnconfirmedHandoff(handoff);
  if (hold) {
    deps.log.warn('a conversation hand-off got no definite answer; holding the message rather than answering it twice', {
      sessionId: input.sessionId,
      reason: hold.reason,
    });
    return hold;
  }
  if (!handoff.disabled) {
    deps.log.warn('this conversation could not be handed to the daemon to host; answering it in this process', {
      sessionId: input.sessionId,
      reason: handoff.reason,
    });
  }
  const record = deps.spawn(buildContinuationSpawnInput({ task, input, ...(routeBinding ? { routeBinding } : {}) }, { ...deps.spawnDeps, sharedSessionContext: true }));
  return { agentId: record.id };
}
