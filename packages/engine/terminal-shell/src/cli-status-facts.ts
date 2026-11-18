import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { OnboardingCheckMarkerState } from './onboarding-state-types.js';
import { resolveRuntimeEndpointBinding } from './cli-endpoints.js';
import { DEFAULT_DECISION_MODEL_POLICY, decisionModelPolicyLabel, decisionModelUse, parseDecisionModelPolicy, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { SubscriptionManager, decisionModelSet, decisionModelSettings, getBuiltinSubscriptionProvider, sharedSubscriptionsPath, type SubscriptionShellPaths } from '@goodvibes-jev/engine/platform/platform/config';
import { getBuiltinProviderEnvVars } from '@goodvibes-jev/engine/platform/platform/config/provider-credential-catalog';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const use = decisionModelUse({ policy, operation: reason === null ? 'decision' : 'no-decision-model', reason, revision: 0 });
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

/** How a provider is signed in and where its model list came from, for `status` and `doctor`. */
export interface CliProviderSignInFacts {
  /** The sign-ins requests use, in order, in words (empty: not signed in). */
  readonly signIns: readonly string[];
  /** Where the model list comes from and how old it is, in words. */
  readonly modelList: string;
}

function listedAt(path: string): { readonly at: number; readonly count: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { fetchedAt?: unknown; models?: unknown };
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) return null;
    return { at: parsed.fetchedAt, count: parsed.models.length };
  } catch { return null; }
}

function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/**
 * Read from files only (status runs without a runtime): the provider's last
 * listings on disk (provider-models/<id>.json and, for a subscription,
 * <id>.subscription.json under the control-plane directory), else the pinned
 * model catalog. A subscription sign-in is used first when it is set up.
 */
export function cliProviderSignInFacts(input: {
  readonly providerId: string;
  readonly persistenceRoot: string;
  readonly subscriptionSignedIn: boolean;
  readonly apiKeyEnvVars: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly now?: number | undefined;
}): CliProviderSignInFacts {
  const env = input.env ?? process.env;
  const keyVar = input.apiKeyEnvVars.find((name) => (env[name] ?? '').length > 0);
  const signIns = [
    ...(input.subscriptionSignedIn ? ['subscription'] : []),
    ...(keyVar ? [`API key (${keyVar})`] : []),
  ];
  const dir = join(input.persistenceRoot, 'provider-models');
  const lists = [listedAt(join(dir, `${input.providerId}.json`)), listedAt(join(dir, `${input.providerId}.subscription.json`))]
    .filter((entry): entry is { at: number; count: number } => entry !== null);
  const now = input.now ?? Date.now();
  const modelList = lists.length > 0
    ? `listed by the provider ${age(now - Math.max(...lists.map((entry) => entry.at)))} ago (${new Date(Math.max(...lists.map((entry) => entry.at))).toISOString()}, ${Math.max(...lists.map((entry) => entry.count))} models); the pinned catalog fills in what it does not list`
    : 'the pinned model catalog: the provider has not listed its models yet';
  return { signIns, modelList };
}

/** The sign-in and model-list facts of the configured model's provider, from the files a status report may read. */
export function readCliProviderSignInFacts(
  config: Pick<ConfigManager, 'get' | 'getControlPlaneConfigDir'>,
  shellPaths: SubscriptionShellPaths,
  providerId: string,
): CliProviderSignInFacts {
  let subscriptionSignedIn = false;
  if (getBuiltinSubscriptionProvider(providerId)) {
    try { subscriptionSignedIn = new SubscriptionManager(sharedSubscriptionsPath(shellPaths)).hasSignIn(providerId); }
    catch { subscriptionSignedIn = false; }
  }
  return cliProviderSignInFacts({
    providerId,
    persistenceRoot: config.getControlPlaneConfigDir(),
    subscriptionSignedIn,
    apiKeyEnvVars: getBuiltinProviderEnvVars(providerId),
  });
}

/** The sign-in line of a status report. */
export function describeCliSignIns(facts: CliProviderSignInFacts): string {
  return facts.signIns.length > 0
    ? facts.signIns.join(', then ')
    : 'none found in the subscription store or the environment (a key stored with /secrets is read by the app, not by this report)';
}
