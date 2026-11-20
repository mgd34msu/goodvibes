/**
 * active-model-identity.ts, the single answer to "which backend is serving
 * this session right now, and is that what the user chose?"
 *
 * Two shell surfaces used to answer that question independently and could
 * therefore contradict each other:
 *   - the top-right header read `providerRegistry.getCurrentModel()` live
 *     every frame, so it followed an automatic failover switch immediately;
 *   - the footer read `runtime.model` / `runtime.provider`, which only
 *     bootstrap and explicit user model switches ever wrote, so it kept
 *     naming the configured backend after failover had moved serving (and
 *     billing) somewhere else.
 *
 * Both surfaces now resolve through resolveActiveModelDisplay() so they are
 * computed from one comparison of serving-vs-configured. Divergence is
 * detected structurally, by comparing the live registry key against the
 * configured selection, not by trusting a flag, so ANY path that moves the
 * registry off the user's choice is surfaced, not just the failover path that
 * sets the record below.
 *
 * The failover record adds the REASON for a divergence ("failover from …");
 * it never decides whether one exists.
 */

/**
 * The live per-turn record of an automatic provider failover.
 *
 * `configuredRegistryKey` is sticky across repeated failovers within one turn
 * (a second hop still reports divergence from what the USER chose, not from
 * the first fallback). `servingRegistryKey` tracks the most recent switch.
 */
export interface FailoverTurnRecord {
  /** The user's configured selection (`provider.model`) when failover began. */
  readonly configuredRegistryKey: string;
  /** The registry key failover switched serving to. */
  readonly servingRegistryKey: string;
}

/** What the live provider registry reports as serving this frame. */
export interface ServingModelIdentity {
  readonly id: string;
  readonly provider: string;
  readonly registryKey?: string | undefined;
}

export interface ActiveModelInputs {
  /** Live registry answer, who is actually serving right now. */
  readonly serving: ServingModelIdentity;
  /** The user's configured selection as a registry key (config `provider.model`). */
  readonly configuredRegistryKey: string | undefined;
  /** The configured selection's footer label (session `runtime.model`). */
  readonly configuredLabel: string | undefined;
  /** The configured selection's provider id (session `runtime.provider`). */
  readonly configuredProvider: string | undefined;
  /**
   * The engine's failover in force for the running turn (the orchestrator's
   * turnFailoverInForce), when one is: the model answering the turn instead of
   * the registry's selection.
   */
  readonly failover: FailoverTurnRecord | null;
}

export interface ActiveModelDisplay {
  /** Model text for the header's right-hand segment. */
  readonly headerModel: string;
  /** Provider text for the header's right-hand segment. */
  readonly headerProvider: string;
  /** Model text for the footer's context-info segment. */
  readonly footerModel: string;
  /** Provider text for the footer's context-info segment. */
  readonly footerProvider: string;
  /**
   * Divergence marker naming the configured selection, e.g.
   * `failover from abacusai:route-llm`. Empty string when serving is the
   * configured selection, in that case both surfaces render exactly as they
   * did before this resolver existed.
   */
  readonly divergenceNote: string;
  /** True when the serving backend is not the user's configured selection. */
  readonly diverged: boolean;
}

/**
 * Decide what the header and footer say about the active model this frame.
 *
 * Divergence requires BOTH a known live registry key and a known configured
 * selection; if either is missing the resolver reports no divergence rather
 * than guessing, because a false "failover" marker would be its own lie. The
 * configured selection is matched against the serving registry key AND the
 * bare serving model id, so a config value stored as a bare model id (rather
 * than the `provider:model` registry key) does not read as permanent divergence.
 */
export function resolveActiveModelDisplay(input: ActiveModelInputs): ActiveModelDisplay {
  // A failover inside the turn leaves the selection alone; the model answering is the record's.
  const failoverServing = input.failover?.servingRegistryKey;
  const separator = failoverServing?.indexOf(':') ?? -1;
  const serving: ServingModelIdentity = failoverServing && separator > 0
    ? { id: failoverServing.slice(separator + 1), provider: failoverServing.slice(0, separator), registryKey: failoverServing }
    : input.serving;
  return resolveDisplayFor({ ...input, serving });
}

function resolveDisplayFor(input: ActiveModelInputs): ActiveModelDisplay {
  const servingKey = input.serving.registryKey;
  const configuredKey = input.configuredRegistryKey;
  const diverged = Boolean(
    servingKey && configuredKey && configuredKey !== servingKey && configuredKey !== input.serving.id,
  );
  if (!diverged) {
    return {
      headerModel: input.serving.id,
      headerProvider: input.serving.provider,
      // Footer keeps its own established label form (runtime.model) when there
      // is nothing to correct, so the unchanged case renders byte-identically.
      footerModel: input.configuredLabel ?? input.serving.id,
      footerProvider: input.configuredProvider ?? input.serving.provider,
      divergenceNote: '',
      diverged: false,
    };
  }
  // Serving != configured. Both surfaces now name the SERVING backend, plus a
  // marker naming the configured selection it departed from. The failover
  // record supplies the reason only when it matches the backend actually
  // serving; any other divergence is described without claiming a cause.
  const causedByFailover = input.failover !== null && input.failover.servingRegistryKey === servingKey;
  const reason = causedByFailover ? 'failover from' : 'not the configured';
  return {
    headerModel: input.serving.id,
    headerProvider: input.serving.provider,
    footerModel: input.serving.id,
    footerProvider: input.serving.provider,
    divergenceNote: `${reason} ${configuredKey}`,
    diverged: true,
  };
}
