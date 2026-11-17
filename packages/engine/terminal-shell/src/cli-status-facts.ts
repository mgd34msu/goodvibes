import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { OnboardingCheckMarkerState } from './onboarding-state-types.js';
import { resolveRuntimeEndpointBinding } from './cli-endpoints.js';
import { DEFAULT_DECISION_MODEL_POLICY, decisionModelPolicyLabel, decisionModelUse, parseDecisionModelPolicy, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { decisionModelSet, decisionModelSettings } from '@goodvibes-jev/engine/platform/platform/config';

/**
 * Whether a decision model is in use, from the settings alone (status runs
 * without a runtime, so a failing model is reported by the running app, not
 * here): the policy as shown to a person, and the standing indication line.
 */
export function cliDecisionModelFacts(config: Pick<ConfigManager, 'get'>, env: Readonly<Record<string, string | undefined>> = process.env) {
  let policy: DecisionModelPolicy;
  try { policy = parseDecisionModelPolicy(config.get('judgment.policy')); }
  catch { policy = DEFAULT_DECISION_MODEL_POLICY; }
  const set = decisionModelSet(decisionModelSettings(key => config.get(key)), env);
  const reason = policy === 'No Decision Model' ? 'selected' as const : set ? null : 'not-set' as const;
  const use = decisionModelUse({ policy, operation: reason === null ? 'decision' : 'classic', reason, revision: 0 });
  return { policy, policyLabel: decisionModelPolicyLabel(policy), set, inUse: use.inUse, line: use.line };
}
export function secretPolicyLabel(policy: unknown): string {
  if (policy === 'preferred_secure') return 'Use secure storage when available';
  if (policy === 'require_secure') return 'Require secure storage';
  if (policy === 'plaintext_allowed') return 'Allow plaintext storage';
  return String(policy ?? 'unknown');
}
/** Shared observed facts; products add their own authority/readiness assessments. */
export function captureCliStatusFacts<Lifecycle>(
  config: Pick<ConfigManager, 'get'>,
  marker: OnboardingCheckMarkerState | null | undefined,
  lifecycle: Lifecycle | undefined,
  providerFromModel: (model: unknown) => string,
) {
  const controlPlane = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const httpListener = resolveRuntimeEndpointBinding(config, 'httpListener');
  const web = resolveRuntimeEndpointBinding(config, 'web');
  return {
    provider: {
      provider: providerFromModel(config.get('provider.model')),
      model: String(config.get('provider.model')),
      reasoning: String(config.get('provider.reasoningEffort')),
    },
    auth: {
      permissionMode: config.get('permissions.mode'),
      secretPolicy: config.get('storage.secretPolicy'),
      secretPolicyLabel: secretPolicyLabel(config.get('storage.secretPolicy')),
    },
    service: {
      enabled: config.get('service.enabled'),
      autostart: config.get('service.autostart'),
      restartOnFailure: config.get('service.restartOnFailure'),
      ...(lifecycle ? { lifecycle } : {}),
    },
    endpoints: {
      controlPlane: { enabled: config.get('controlPlane.enabled'), ...controlPlane },
      httpListener: { enabled: config.get('danger.httpListener'), ...httpListener },
      web: { enabled: config.get('web.enabled'), ...web },
    },
    onboarding: { checked: Boolean(marker?.exists), scope: marker?.scope ?? 'none', updatedAt: marker?.payload?.updatedAt ?? null },
    decisionModel: cliDecisionModelFacts(config),
  };
}
