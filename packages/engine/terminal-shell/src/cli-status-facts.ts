import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { OnboardingCheckMarkerState } from './onboarding-state-types.js';
import { resolveRuntimeEndpointBinding } from './cli-endpoints.js';
import { resolveWebSurfaceExposure } from './cli-network-posture.js';
import { DEFAULT_DECISION_MODEL_POLICY, decisionModelPolicyLabel, decisionModelUse, parseDecisionModelPolicy, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { SubscriptionManager, decisionModelSet, decisionModelSettings, getBuiltinSubscriptionProvider, sharedSubscriptionsPath, type SubscriptionShellPaths } from '@goodvibes-jev/engine/platform/platform/config';
import { getBuiltinProviderEnvVars } from '@goodvibes-jev/engine/platform/platform/config/provider-credential-catalog';
import { describePermissionModeInForce, type PermissionModeInForce } from '@goodvibes-jev/engine/platform/platform/permissions';
import { gatePresetLabel } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinProviderNames, resolveSavedModelInUse } from '@goodvibes-jev/engine/platform/platform/providers/provider-names';
import { readCustomProviderNames } from '@goodvibes-jev/engine/platform/platform/providers/custom-provider-files';
import { loadPersistedProviders } from '@goodvibes-jev/engine/platform/platform/discovery/persisted-providers';
import type { DiscoveredServer } from '@goodvibes-jev/engine/platform/platform/discovery';

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
/**
 * The status report's permission lines: the mode in force and, when it is not
 * the saved mode, the saved mode and why. Status runs without a runtime: a set
 * decision model that is failing is reported by the running app (its
 * `/permissions`, its mode chip and its notice), whose mode it changes.
 */
export function describeCliPermissionMode(inForce: PermissionModeInForce): readonly string[] {
  if (inForce.reason === undefined) return [`  permissions: ${gatePresetLabel(inForce.mode)} (${inForce.mode})`];
  return [
    `  permissions: ${gatePresetLabel(inForce.mode)} (${inForce.mode}) in force; set: ${inForce.chosen}`,
    `    not ${inForce.chosen}, because ${inForce.reason}`,
  ];
}
export function secretPolicyLabel(policy: unknown): string {
  if (policy === 'preferred_secure') return 'Use secure storage when available';
  if (policy === 'require_secure') return 'Require secure storage';
  if (policy === 'plaintext_allowed') return 'Allow plaintext storage';
  return String(policy ?? 'unknown');
}
/**
 * The model a turn started now would use: `provider.model` (with any `-m` or
 * `--provider` of this launch) resolved by the provider registry exactly as a
 * run resolves it, so a provider named in another letter case or by its
 * display name is shown as the registered one. `problem` says why it cannot be
 * used (no registered provider has that name) and how to choose another.
 */
export interface CliModelInUse {
  readonly registryKey: string;
  readonly provider: string;
  readonly problem?: string | undefined;
}

/** Reads {@link CliModelInUse} from a provider registry that has loaded custom providers and the saved scan. */
export function readCliModelInUse(registry: {
  getCurrentModel(): { readonly registryKey: string; readonly provider: string };
  isUnregisteredModel(model: { readonly provider: string }): boolean;
  unregisteredModelMessage(registryKey: string): string;
}): CliModelInUse {
  const model = registry.getCurrentModel();
  return registry.isUnregisteredModel(model)
    ? { registryKey: model.registryKey, provider: model.provider, problem: registry.unregisteredModelMessage(model.registryKey) }
    : { registryKey: model.registryKey, provider: model.provider };
}

/**
 * {@link CliModelInUse} from the saved names alone, without building a
 * provider registry: the built-in provider names, the custom provider files in
 * the settings directory, and the servers the saved scan lists that the
 * product registers (`trustScannedServer`, with models, under a name no other
 * provider holds), as the registry registers them. Null when only the
 * registry can answer (a bare model id, a provider half that names no
 * provider, a provider sharing its model catalog with another): the caller
 * then builds it and reads {@link readCliModelInUse}.
 */
export function readSavedCliModelInUse(
  config: Pick<ConfigManager, 'get' | 'getControlPlaneConfigDir'>,
  saved: {
    readonly homeDirectory: string;
    readonly surfaceRoot: string;
    readonly trustScannedServer: (server: DiscoveredServer) => boolean;
  },
): CliModelInUse | null {
  const builtin = builtinProviderNames();
  const custom = readCustomProviderNames(join(config.getControlPlaneConfigDir(), 'providers'), builtin);
  const taken = new Set<string>([...builtin, ...custom.map((entry) => entry.name)]);
  const scanned: string[] = [];
  for (const server of loadPersistedProviders({ homeDirectory: saved.homeDirectory, surfaceRoot: saved.surfaceRoot })) {
    if (taken.has(server.name) || server.models.length === 0 || !saved.trustScannedServer(server)) continue;
    taken.add(server.name);
    scanned.push(server.name);
  }
  return resolveSavedModelInUse(config.get('provider.model'), { builtin, custom, scanned });
}

/** Shared observed facts; products add their own authority/readiness assessments. */
export function captureCliStatusFacts<Lifecycle>(
  config: Pick<ConfigManager, 'get'>,
  marker: OnboardingCheckMarkerState | null | undefined,
  lifecycle: Lifecycle | undefined,
  providerFromModel: (model: unknown) => string,
  /** The model resolved as a run resolves it; absent, the setting as written. */
  modelInUse?: CliModelInUse,
) {
  const controlPlane = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const httpListener = resolveRuntimeEndpointBinding(config, 'httpListener');
  // The web UI is described by the listener that serves it; web.* is only a development server's endpoint.
  const web = resolveWebSurfaceExposure(config);
  const webSwitchedOn = config.get('web.enabled') === true;
  return {
    provider: {
      provider: modelInUse?.provider ?? providerFromModel(config.get('provider.model')),
      model: modelInUse?.registryKey ?? String(config.get('provider.model')),
      ...(modelInUse?.problem ? { problem: modelInUse.problem } : {}),
      reasoning: String(config.get('provider.reasoningEffort')),
    },
    auth: {
      permissionMode: config.get('permissions.mode'),
      // The mode a session started now runs by, read the way the gate reads it, and why it is not the saved one.
      permissionModeInForce: describePermissionModeInForce(config),
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
      web: {
        enabled: webSwitchedOn && web.served,
        ...web.binding,
        served: web.served,
        networkFacing: webSwitchedOn && web.networkFacing,
        developmentEndpoint: resolveRuntimeEndpointBinding(config, 'web'),
      },
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
  /** The provider, and the environment variables that sign it in with a key, for the line that says how to sign in. */
  readonly providerId?: string;
  readonly apiKeyEnvVars?: readonly string[];
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
    : 'the pinned catalog that ships with this release (the provider\'s own list is read once requests to it are signed in)';
  return { signIns, modelList, providerId: input.providerId, apiKeyEnvVars: input.apiKeyEnvVars };
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
  // A custom provider's key variable is the one its file names (apiKeyEnv), as the registry reads it.
  const builtinVars = getBuiltinProviderEnvVars(providerId);
  const customVar = builtinVars.length > 0 ? undefined
    : readCustomProviderNames(join(config.getControlPlaneConfigDir(), 'providers'), builtinProviderNames())
      .find((entry) => entry.name === providerId)?.apiKeyEnv;
  return cliProviderSignInFacts({
    providerId,
    persistenceRoot: config.getControlPlaneConfigDir(),
    subscriptionSignedIn,
    apiKeyEnvVars: customVar !== undefined ? [customVar] : builtinVars,
  });
}

/** The sign-in line of a status report. */
export function describeCliSignIns(facts: CliProviderSignInFacts): string {
  if (facts.signIns.length > 0) return facts.signIns.join(', then ');
  // A key stored with /secrets is in the secret store, which this report does
  // not open; say so, and the one way to give a key that it does see.
  const variable = facts.apiKeyEnvVars?.[0];
  const provider = facts.providerId ?? 'the provider';
  return variable
    ? `no subscription and no ${variable} in the environment. If you saved a key with /secrets, the app uses it (this report does not read stored keys); otherwise sign in with: export ${variable}=<key>, or /secrets in the app`
    : `no subscription found for ${provider}. If you saved a key with /secrets, the app uses it (this report does not read stored keys); otherwise sign in with /secrets in the app`;
}
