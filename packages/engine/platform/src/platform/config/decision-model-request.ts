/**
 * Where a decision request goes and the model it names, from the judgment
 * settings and the environment. Kept apart from decision-model-set.ts, which
 * browser surfaces load, because the defaults come from the full judgment
 * package.
 */
import { DEFAULT_MODEL, HOSTED_BASE_URL } from '@goodvibes-jev/judgment';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The model a decision request names when the decision names none:
 * judgment.model, then TYPESAFE_DEFAULT_MODEL, then the judgment package's
 * default (`jev-latest`). The one answer for the requests themselves
 * (runtime/judgment-services.ts) and for whether the gate's decisions were
 * measured on that model (permissions/decision-model-readiness.ts).
 */
export function requestedDecisionModel(model: unknown, env: Readonly<Record<string, string | undefined>>): string {
  return text(model) || text(env['TYPESAFE_DEFAULT_MODEL']) || DEFAULT_MODEL;
}

/**
 * The endpoint a decision request goes to: judgment.endpoint, then
 * TYPESAFE_BASE_URL, then the hosted endpoint. The same order
 * runtime/judgment-services.ts builds a request's base URL in.
 */
export function requestedDecisionEndpoint(endpoint: unknown, env: Readonly<Record<string, string | undefined>>): string {
  return text(endpoint) || text(env['TYPESAFE_BASE_URL']) || HOSTED_BASE_URL;
}
