import { measureLlmRoute } from '@goodvibes/engine/platform/platform/runtime/observability';
import type { ModelProviderHealthSignal } from './agent-harness-model-routing-types.ts';

const POLICY = 'Provider health is what this Agent process measured on its own provider calls: successes, errors and latency per provider and model. Local benchmark artifacts remain separate task-fit evidence.';

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

/**
 * The live health of one provider route. Every provider call the Agent makes
 * is recorded with its provider and model (the engine's LLM call metrics), so
 * this is a lookup: a measurement of the exact model when it was used, else of
 * the provider as a whole, else "not measured" with the step that measures it.
 */
export function readProviderHealthSignal(providerId: string, modelRouteId?: string, modelId?: string): ModelProviderHealthSignal {
  const route = modelId ? measureLlmRoute(providerId, modelId) : undefined;
  const provider = measureLlmRoute(providerId);
  const measurement = route && route.successCalls + route.errorCalls > 0 ? route : provider;
  const calls = measurement.successCalls + measurement.errorCalls;
  if (calls === 0) {
    return {
      status: 'not-measured',
      providerId,
      ...(modelRouteId ? { modelRouteId } : {}),
      source: 'agent-provider-calls',
      missingSignals: [`No call to provider "${providerId}" has been made in this Agent session, so there is no live latency or error rate yet. A turn or a model comparison on this route measures it.`],
      policy: POLICY,
    };
  }
  const exact = measurement === route;
  return {
    status: 'measured',
    providerId,
    ...(modelRouteId ? { modelRouteId } : {}),
    ...(exact && modelRouteId ? { measuredRouteId: modelRouteId } : {}),
    measuredProviderId: providerId,
    measurementRecordedAt: iso(measurement.lastMeasuredAt),
    source: 'agent-provider-calls',
    successCalls: measurement.successCalls,
    errorCalls: measurement.errorCalls,
    errorRate: measurement.errorCalls / calls,
    ...(measurement.avgLatencyMs !== null ? { avgLatencyMs: Math.round(measurement.avgLatencyMs) } : {}),
    ...(measurement.minLatencyMs !== null ? { minLatencyMs: measurement.minLatencyMs } : {}),
    ...(measurement.maxLatencyMs !== null ? { maxLatencyMs: measurement.maxLatencyMs } : {}),
    missingSignals: exact ? [] : [`Measured for provider "${providerId}" as a whole; this exact model has not been called in this session.`],
    policy: POLICY,
  };
}
