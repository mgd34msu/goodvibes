/**
 * What an inbound shared-session follow-up is spawned with: the one decision the
 * daemon and both terminal products make for it.
 *
 * `restrictTools: true` with no tool list means an empty registry: an agent that
 * can answer and do nothing else. So a follow-up that starts a contract (an
 * explicit work authorization, or a local surface) keeps the full tool set; any
 * other follow-up is a conversation, spawned with the tools a conversational turn
 * needs and the write authority of the channel it arrived on.
 *
 * The routing is resolved against the live models: a unique bare model id is
 * qualified, an ambiguous or unknown one throws naming the candidates, so the
 * session broker records a failed input instead of running on another model.
 */
import { continuationContractOptions, decideContinuationEscalation } from '../agents/conversation-continuation.js';
import type { ConversationGateConfigReader } from '../agents/conversation-gate.js';
import { buildSharedSessionAgentSpawnRoutingInput, type SharedSessionContinuationRequest } from '../control-plane/session-intents.js';
import { conversationalTurnSpawnOptions, type ConversationalTurnConfigReader } from '../personal-capture/spawn-contract.js';
import type { ModelIdCandidate } from '../providers/model-id-resolution.js';
import type { AgentManager } from '../tools/agent/index.js';

export interface ContinuationSpawnDeps {
  /** The live config manager: it answers both the conversation-gate keys and the capture-authority keys. */
  readonly configReader: ConversationGateConfigReader & ConversationalTurnConfigReader;
  readonly modelCandidates: readonly ModelIdCandidate[];
  /**
   * Give a contract-starting follow-up the shared session as its context. The
   * terminal products do; the daemon's own runner does not.
   */
  readonly sharedSessionContext?: boolean | undefined;
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
    // The agent answers this shared session; its reports and listings belong to it.
    sessionId: input.sessionId,
    ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { modelCandidates: deps.modelCandidates }),
    // Conversation first: a follow-up gets an answer, not a write-review-fix
    // chain. Both `conversationGate.mode` and `gatedSurfaces` read the live config.
    ...(escalation.startsContract
      ? (deps.sharedSessionContext ? { context: `shared-session:${input.sessionId}` } : {})
      : {
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
