import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type {
  ProviderFailurePolicy,
  ProviderRoutingSelection,
} from '../automation/types.js';
import type { ExecutionIntent } from '../runtime/execution-intents.js';
import { resolveModelReference, type ModelIdCandidate } from '../providers/model-id-resolution.js';
import { sameProviderCatalog } from '../providers/provider-aliases.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';

export const SHARED_SESSION_INPUT_INTENTS = ['submit', 'steer', 'follow-up'] as const;
export const SHARED_SESSION_INPUT_STATES = ['queued', 'delivered', 'spawned', 'completed', 'cancelled', 'failed', 'rejected'] as const;

export type SharedSessionInputIntent = typeof SHARED_SESSION_INPUT_INTENTS[number];
export type SharedSessionInputState = typeof SHARED_SESSION_INPUT_STATES[number];

/**
 * Where a session input may go next. `queued` is waiting for whoever answers it
 * (a spawned agent, a live agent, a surface); `delivered` and `spawned` are
 * being answered; the rest are final. Refusals read as
 * "session input is spawned and cannot become cancelled; from spawned it can
 * become completed, failed, cancelled", which is what the cancel and deliver
 * verbs answer with.
 */
export const sharedSessionInputLifecycle = defineLifecycle<SharedSessionInputState>('session input', {
  queued: ['delivered', 'spawned', 'completed', 'cancelled', 'failed', 'rejected'],
  delivered: ['completed', 'failed', 'cancelled'],
  spawned: ['completed', 'failed', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
  rejected: [],
});

/** Persisted quarantine only. This public value NEVER establishes a source binding. */
export const SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY = 'delegatedInputQuarantined';
export function isDelegatedSessionInput(input: { readonly metadata?: Record<string, unknown> | undefined }): boolean {
  return input.metadata?.[SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY] === true;
}

export interface SharedSessionHelperModelOverride {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SharedSessionRoutingIntent {
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerSelection?: ProviderRoutingSelection | undefined;
  readonly providerFailurePolicy?: ProviderFailurePolicy | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
  readonly helperModel?: SharedSessionHelperModelOverride | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * The input metadata key naming the surface process that is running the agent a
 * delivered input is bound to (`<host>:<pid>:<nonce>`), written only by a
 * surface's `sessions.inputs.deliver` with an agent. A restarted surface reads it
 * to fail the delivered inputs a process that is gone was answering.
 */
export const SURFACE_INSTANCE_METADATA_KEY = 'deliveringSurfaceInstance';

export interface SharedSessionInputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly intent: SharedSessionInputIntent;
  readonly state: SharedSessionInputState;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly routeId?: string | undefined;
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  readonly surfaceId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly activeAgentId?: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly routing?: SharedSessionRoutingIntent | undefined;
  readonly error?: string | undefined;
}

export interface SharedSessionContinuationRequest {
  readonly sessionId: string;
  readonly input: SharedSessionInputRecord;
  readonly task: string;
  readonly routeBinding?: AutomationRouteBinding | undefined;
}

/** Legacy callers may still return an agent id or null. Native callers must be explicit. */
export interface SharedSessionContinuationResult { readonly agentId: string; readonly disposition?: 'started'; }
export type SharedSessionContinuationOutcome =
  | SharedSessionContinuationResult
  | { readonly disposition: 'held' | 'unknown'; readonly reason: string; readonly agentId?: never }
  /** Every agent slot is taken: the input stays queued and starts when an agent ends. */
  | { readonly disposition: 'capacity'; readonly reason: string; readonly agentId?: never }
  | { readonly disposition: 'transferred'; readonly requestId: string; readonly inputConsumed?: true; readonly agentId?: never };

export type SharedSessionContinuationRunner = (
  input: SharedSessionContinuationRequest,
) => SharedSessionContinuationOutcome | Promise<SharedSessionContinuationOutcome | null> | null;

/**
 * "This agent is going to answer THIS message, and the message came in over a
 * channel."
 *
 * The broker is the one place every route into a shared session converges on,
 * a webhook adapter, a polled surface, an HTTP route, a gateway method, and the
 * shared-session continuation runner all end up here. Announcing the pairing
 * from the broker is therefore the only way to guarantee the answer is routed
 * back to the conversation it came from on EVERY path; binding it per adapter
 * covered the fresh-spawn branch only, so a message that landed in an existing
 * live session was answered into the void.
 *
 * Implementations must be idempotent: several paths legitimately announce the
 * same (agent, input) pairing, and the reply must be sent once.
 */
export interface SharedSessionSurfaceReplyBinding {
  readonly sessionId: string;
  /** The agent whose completion carries the answer. */
  readonly agentId: string;
  /** The route binding id for the originating conversation, when known. */
  readonly routeId?: string | undefined;
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  /** The owner's own words, for the reply header. */
  readonly task: string;
  /** How this pairing came about, carried into logs when nothing can be sent. */
  readonly reason: 'spawn-claimed-input' | 'continued-live' | 'continuation-runner';
}

export type SharedSessionSurfaceReplyBinder = (binding: SharedSessionSurfaceReplyBinding) => void;

export interface SharedSessionAgentSpawnRoutingInput {
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly tools?: string[] | undefined;
  readonly restrictTools?: boolean | undefined;
  readonly routing?: {
    readonly providerSelection?: ProviderRoutingSelection | undefined;
    readonly providerFailurePolicy?: ProviderFailurePolicy | undefined;
    readonly fallbackModels?: string[] | undefined;
  } | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * When `modelCandidates` (the live registry's model list) is supplied, a
 * bare id with no provider hint resolves via the shared resolver (unique
 * across the registry -> auto-qualify; ambiguous/unknown -> a rich error
 * naming real candidates) instead of the old abstract format lecture. With
 * a provider hint the id is kept when it already starts with `provider:` or
 * is a registryKey of that provider, refused when it is a registryKey of a
 * different provider, and otherwise qualified as `provider:id`, so an id
 * that itself holds a colon (Ollama's `llama3:8b`) qualifies correctly.
 */
function normalizeSharedSessionModelId(
  modelId: string | undefined,
  providerId: string | undefined,
  modelCandidates?: readonly ModelIdCandidate[],
): string | undefined {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) return undefined;
  const trimmedProviderId = providerId?.trim();
  if (trimmedProviderId) {
    if (trimmedModelId.startsWith(`${trimmedProviderId}:`)) return trimmedModelId;
    const keyed = modelCandidates?.find((candidate) => candidate.registryKey === trimmedModelId);
    if (keyed) {
      if (keyed.provider === trimmedProviderId || sameProviderCatalog(keyed.provider, trimmedProviderId)) return trimmedModelId;
      throw new Error(`Shared-session routing model '${trimmedModelId}' conflicts with provider '${trimmedProviderId}'.`);
    }
    return `${trimmedProviderId}:${trimmedModelId}`;
  }
  if (modelCandidates) {
    try {
      return resolveModelReference(trimmedModelId, modelCandidates);
    } catch (err) {
      throw new Error(`Shared-session routing model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (trimmedModelId.includes(':')) return trimmedModelId;
  throw new Error(`Shared-session routing model '${trimmedModelId}' must be provider-qualified.`);
}

function normalizeSharedSessionFallbackModels(
  models: readonly string[] | undefined,
  modelCandidates?: readonly ModelIdCandidate[],
): string[] {
  return (models ?? [])
    .filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
    .map((model) => {
      const trimmed = model.trim();
      if (modelCandidates) {
        try {
          return resolveModelReference(trimmed, modelCandidates);
        } catch (err) {
          throw new Error(`Shared-session fallback model: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (trimmed.includes(':')) return trimmed;
      throw new Error(`Shared-session fallback model '${model}' must be provider-qualified.`);
    });
}

export function buildSharedSessionAgentSpawnRoutingInput(
  routing: SharedSessionRoutingIntent | undefined,
  options: {
    readonly restrictTools?: boolean | undefined;
    /** The live registry's model candidates, enables bare model id resolution when supplied. */
    readonly modelCandidates?: readonly ModelIdCandidate[] | undefined;
  } = {},
): SharedSessionAgentSpawnRoutingInput {
  if (!routing) return options.restrictTools ? { restrictTools: true } : {};
  const provider = routing.providerId?.trim();
  const model = normalizeSharedSessionModelId(routing.modelId, provider, options.modelCandidates);
  if (provider && !model) {
    throw new Error('Shared-session provider routing requires a provider-qualified model when provider is supplied.');
  }
  const fallbackModels = normalizeSharedSessionFallbackModels(routing.fallbackModels, options.modelCandidates);
  const providerFailurePolicy = routing.providerFailurePolicy ?? (
    fallbackModels.length ? 'ordered-fallbacks' : 'fail'
  );
  if (providerFailurePolicy === 'ordered-fallbacks' && fallbackModels.length === 0) {
    throw new Error('Shared-session ordered fallback routing requires at least one provider-qualified fallback model.');
  }
  if (providerFailurePolicy === 'fail' && fallbackModels.length > 0) {
    throw new Error('Shared-session fail routing cannot include fallback models; use ordered-fallbacks to enable model failover.');
  }
  const agentRouting = {
    providerSelection: routing.providerSelection ?? (provider ? 'concrete' : 'inherit-current'),
    providerFailurePolicy,
    ...(fallbackModels.length ? { fallbackModels } : {}),
  };
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(routing.tools?.length ? { tools: [...routing.tools] } : {}),
    ...(options.restrictTools ? { restrictTools: true } : {}),
    routing: agentRouting,
    ...(routing.executionIntent ? { executionIntent: routing.executionIntent } : {}),
    ...(routing.reasoningEffort ? { reasoningEffort: routing.reasoningEffort } : {}),
  };
}

export interface SharedSessionCompletion {
  readonly session: {
    readonly id: string;
    readonly activeAgentId?: string | undefined;
  };
  readonly continuedInput?: SharedSessionInputRecord | undefined;
  readonly continuedAgentId?: string | undefined;
}
