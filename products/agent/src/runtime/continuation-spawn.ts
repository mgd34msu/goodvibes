/**
 * continuation-spawn.ts, what an inbound shared-session follow-up is spawned with.
 *
 * `restrictTools: true` with no tool list means an empty registry: an agent that
 * can answer and do nothing else. So the decision is made once here, the same
 * one the daemon and the platform runtime make: a follow-up that starts a
 * contract (an explicit work authorization, or a local surface) keeps the full
 * tool set; any other follow-up is a conversation, spawned with the tools a
 * conversational turn needs and the write authority of the channel it arrived on.
 */
import { continuationContractOptions, decideContinuationEscalation } from '@goodvibes-jev/engine/platform/platform/agents';
import { buildSharedSessionAgentSpawnRoutingInput } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { SharedSessionContinuationRequest } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { conversationalTurnSpawnOptions, type ConversationalTurnConfigReader } from '@goodvibes-jev/engine/platform/platform/personal-capture';
import type { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { heldDispositionForUnconfirmedHandoff, type HostedConversationHandoff } from './client/hosted-handoff.ts';

type ModelCandidates = NonNullable<Parameters<typeof buildSharedSessionAgentSpawnRoutingInput>[1]>['modelCandidates'];

type GateConfigReader = NonNullable<NonNullable<Parameters<typeof decideContinuationEscalation>[1]>['configReader']>;

export interface ContinuationSpawnDeps {
  /** The live config manager: it answers both the conversation-gate keys and the capture-authority keys. */
  readonly configReader: GateConfigReader & ConversationalTurnConfigReader;
  readonly modelCandidates: ModelCandidates;
}

export function buildContinuationSpawnInput(
  request: Pick<SharedSessionContinuationRequest, 'task' | 'input' | 'routeBinding'>,
  deps: ContinuationSpawnDeps,
): Parameters<AgentManager['spawn']>[0] {
  const { task, input, routeBinding } = request;
  const escalation = decideContinuationEscalation(input, { configReader: deps.configReader });
  const address = routeBinding?.channelId ?? input.externalId;
  return {
    mode: 'spawn',
    task,
    // Resolves through the platform's shared model-reference resolver (a unique
    // bare id auto-qualifies; an ambiguous or unknown one throws naming the
    // candidates).
    ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { modelCandidates: deps.modelCandidates }),
    // Conversation first: a follow-up gets an answer, not a write-review-fix
    // chain. Both `conversationGate.mode` and `gatedSurfaces` read the live config.
    ...(escalation.startsContract ? { context: `shared-session:${input.sessionId}` } : {
      ...continuationContractOptions(input, { configReader: deps.configReader }),
      ...conversationalTurnSpawnOptions(input, {
        configReader: deps.configReader,
        tools: input.routing?.tools,
        channel: {
          routed: true,
          ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
          ...(address ? { address } : {}),
        },
      }),
    }),
  };
}

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
  const record = deps.spawn(buildContinuationSpawnInput({ task, input, ...(routeBinding ? { routeBinding } : {}) }, deps.spawnDeps));
  return { agentId: record.id };
}
