/**
 * continuation-spawn.ts, what an inbound shared-session follow-up is spawned with.
 *
 * A spawn that is not outside every contract starts one, so a follow-up the
 * conversation gate treats as conversation (a channel reply on a gated surface)
 * must be spawned `outsideContract` with a conversational reply, the same rule the
 * daemon and the Agent runner apply. Routing goes through the shared builder so a
 * bare model id is resolved against the live models, provider-qualified names are
 * checked, and an invalid fallback policy is refused instead of passed to the spawn.
 */
import { continuationContractOptions } from '@goodvibes-jev/engine/platform/platform/agents';
import { buildSharedSessionAgentSpawnRoutingInput } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { SharedSessionContinuationRequest } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';

type ModelCandidates = NonNullable<Parameters<typeof buildSharedSessionAgentSpawnRoutingInput>[1]>['modelCandidates'];
type GateConfigReader = NonNullable<NonNullable<Parameters<typeof continuationContractOptions>[1]>['configReader']>;

export interface ContinuationSpawnDeps {
  /** The live config manager: it answers the conversation-gate keys. */
  readonly configReader: GateConfigReader;
  readonly modelCandidates: ModelCandidates;
}

/** Throws when the routing is invalid, so the broker sees a failed (not consumed) input. */
export function buildContinuationSpawnInput(
  request: Pick<SharedSessionContinuationRequest, 'task' | 'input'>,
  deps: ContinuationSpawnDeps,
): Parameters<AgentManager['spawn']>[0] {
  const { task, input } = request;
  return {
    mode: 'spawn',
    task,
    // The agent answers this shared session; its reports and listings belong to it.
    sessionId: input.sessionId,
    ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { modelCandidates: deps.modelCandidates }),
    // `restrictTools` with no list would leave an empty registry, so it is set only for a stated list.
    ...(input.routing?.tools?.length ? { restrictTools: true } : {}),
    ...continuationContractOptions(input, { configReader: deps.configReader }),
    context: `shared-session:${input.sessionId}`,
  };
}
