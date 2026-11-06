import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { OnboardingCheckMarkerState } from './onboarding-state-types.js';
import { resolveRuntimeEndpointBinding } from './cli-endpoints.js';
export function secretPolicyLabel(policy: unknown): string {
  if (policy === 'preferred_secure') return 'Use secure storage when available';
  if (policy === 'require_secure') return 'Require secure storage';
  if (policy === 'plaintext_allowed') return 'Allow plaintext storage';
  return String(policy ?? 'unknown');
}
/** Shared observed facts; products add their own authority/readiness assessments. */
export function captureCliStatusFacts<Lifecycle>(
  config: Pick<ConfigManager, 'get'>,
  marker: OnboardingCheckMarkerState | undefined,
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
  };
}
