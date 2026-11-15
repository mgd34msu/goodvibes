import type { Fetch } from '@typesafe-ai/sdk';
import { JudgmentError } from './errors.ts';
import { retryPolicy, type JudgmentRetryPolicy } from './retry.ts';
import { validEndpointURL } from './endpoint-validation.ts';
import { MAX_DECISION_DEADLINE_MS, validDecisionDeadline } from './deadline.ts';
import { captureJudgmentBackendSettings, type JudgmentBackendSettings } from './backend-settings.ts';
export { isPinnedJudgmentModel, validEndpointURL } from './endpoint-validation.ts';
export {
  DEADLINE_COOLDOWN_MS, DEADLINE_MISSES_BEFORE_COOLDOWN, DEFAULT_DECISION_DEADLINE_MS, MAX_DECISION_DEADLINE_MS, validDecisionDeadline,
} from './deadline.ts';

/** The hosted System One endpoint. */
export const HOSTED_BASE_URL = 'https://api.typesafe.ai';

/** Follow TypeSafe's most recent stable Jev release. Responses retain the resolved version. */
export const DEFAULT_MODEL = 'jev-latest';


/**
 * Where judgments are answered. `hosted` is TypeSafe's Jev endpoint; `local`
 * is a System One model the owner runs themselves. Both speak the same wire
 * protocol (POST /v1/systemone), so only the address and key differ.
 */
export interface JudgmentEndpoint extends JudgmentBackendSettings {
  readonly kind: 'hosted' | 'local';
  readonly baseURL: string;
  readonly apiKey: string;
  readonly authentication?: 'bearer' | 'none';
}

/** An explicitly configured decision model target, in failover order. */
export interface JudgmentFallback {
  readonly endpoint: JudgmentEndpoint;
  /** The model or alias to request from this target, independently of the primary. */
  readonly model: string;
}

export interface JudgmentConfig {
  /** Cancels every call made through this port; requests may also supply a narrower owner. */
  readonly signal?: AbortSignal;
  readonly endpoint: JudgmentEndpoint;
  /** The model id or alias to ask; defaults to {@link DEFAULT_MODEL}. */
  readonly model: string;
  /** Finite per-target timeout in milliseconds; legacy 0 selects the 30-second default. */
  readonly timeoutMs: number;
  /**
   * The deadline `judge` gives a decision a person or tool call waits on when
   * the caller names none; defaults to {@link DEFAULT_DECISION_DEADLINE_MS}.
   * A request bounds its own total time with `deadlineMs`.
   */
  readonly decisionDeadlineMs?: number;
  /** Timing of the one bounded retry after a transient failure and of a target's cooldown; it never delays independent fallbacks. */
  readonly retry: Partial<JudgmentRetryPolicy>;
  /** Additional System One targets. No discovery or implicit alternate providers. */
  readonly fallbacks?: readonly JudgmentFallback[];
  /** Custom fetch, for tests and transport configuration. */
  readonly fetch?: Fetch;
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

/** Only a literal 127.0.0.0/8 address is loopback; a DNS name that merely begins with "127." is not. */
function isLoopbackIPv4(host: string): boolean {
  const octets = host.split('.');
  return octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) && octets[0] === '127';
}

/** A base URL on a loopback host is a local System One model. */
export function endpointKind(baseURL: string): JudgmentEndpoint['kind'] {
  const host = new URL(baseURL).hostname;
  return LOOPBACK_HOSTS.has(host) || isLoopbackIPv4(host) ? 'local' : 'hosted';
}

/**
 * Builds the config from the standard TypeSafe environment variables:
 * TYPESAFE_API_KEY, TYPESAFE_BASE_URL (a loopback address selects a local
 * model) and TYPESAFE_DEFAULT_MODEL.
 */
export function judgmentConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<Omit<JudgmentConfig, 'endpoint'>> = {},
): JudgmentConfig {
  const apiKey = env['TYPESAFE_API_KEY']?.trim();
  if (!apiKey) {
    throw new JudgmentError('invalid-request', 'TYPESAFE_API_KEY is not set; the judgment port has no key');
  }
  const baseURL = env['TYPESAFE_BASE_URL']?.trim() || HOSTED_BASE_URL;
  if (!validEndpointURL(baseURL)) throw new JudgmentError('invalid-request', 'invalid System One endpoint URL; credentials, query and fragment are not allowed');
  return {
    endpoint: { kind: endpointKind(baseURL), baseURL, apiKey },
    model: overrides.model ?? (env['TYPESAFE_DEFAULT_MODEL']?.trim() || DEFAULT_MODEL),
    timeoutMs: overrides.timeoutMs ?? 30_000,
    retry: overrides.retry ?? {},
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.decisionDeadlineMs === undefined ? {} : { decisionDeadlineMs: overrides.decisionDeadlineMs }),
    ...(overrides.fallbacks === undefined ? {} : { fallbacks: overrides.fallbacks }),
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
  };
}

/** Validate the complete chain before constructing clients or transmitting state. */
export function validateJudgmentConfig(config: JudgmentConfig): void {
  if (config.signal !== undefined && !(config.signal instanceof AbortSignal)) {
    throw new JudgmentError('invalid-request', 'judgment port ownership requires an AbortSignal');
  }
  if (!Array.isArray(config.fallbacks ?? [])) throw new JudgmentError('invalid-request', 'judgment fallback targets must be an array');
  const targets = [{ endpoint: config.endpoint, model: config.model }, ...(config.fallbacks ?? [])];
  for (const target of targets) {
    if (!target || !target.endpoint || !['hosted', 'local'].includes(target.endpoint.kind)
      || !validEndpointURL(target.endpoint.baseURL) || typeof target.endpoint.apiKey !== 'string'
      || typeof target.model !== 'string' || !target.model.trim()) {
      throw new JudgmentError('invalid-request', 'invalid judgment target; use an http(s) URL without credentials, query or fragment, a model and a resolved key');
    }
    const endpoint = target.endpoint;
    try {
      captureJudgmentBackendSettings({
        ...(endpoint.adapter === undefined ? {} : { adapter: endpoint.adapter }),
        ...(endpoint.maxInputBytes === undefined ? {} : { maxInputBytes: endpoint.maxInputBytes }),
        ...(endpoint.maxQuestions === undefined ? {} : { maxQuestions: endpoint.maxQuestions }),
        ...(endpoint.responseModels === undefined ? {} : { responseModels: endpoint.responseModels }),
      });
      if (endpoint.authentication !== undefined && !['bearer', 'none'].includes(endpoint.authentication)) throw new Error('Invalid authentication');
    } catch {
      throw new JudgmentError('invalid-request', 'invalid judgment backend capabilities or model aliases');
    }
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 0 || config.timeoutMs > 2_147_483_647
    || 'totalTimeoutMs' in config) {
    throw new JudgmentError('invalid-request', 'judgment attempt timeout must be 0 or valid timer milliseconds; total-time limits belong on a request as deadlineMs');
  }
  if (config.decisionDeadlineMs !== undefined && !validDecisionDeadline(config.decisionDeadlineMs)) {
    throw new JudgmentError('invalid-request', `the decision deadline must be whole milliseconds from 1 to ${MAX_DECISION_DEADLINE_MS}`);
  }
  retryPolicy(config.retry);
}
