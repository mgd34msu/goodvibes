import { buildFallbackSecretReview } from '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';
import { sortUnique, buildProviderRoutingSnapshot, buildRuntimeDefaultsSnapshot, buildConfiguredSurfaceKinds, sortSurfaceRecords, buildFallbackAuthSnapshot, buildAcknowledgementSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';
import type { SecretStorageReview } from '../../config/secrets.ts';
import { getProviderIdFromModel } from '../../config/provider-model.ts';
import { summarizeAgentBehaviorDiscovery } from '../../agent/behavior-discovery-summary.ts';
import { readOnboardingRuntimeState } from './state.ts';
import { captureNativeReadRestrictions } from '../read-restrictions.ts';
import type {
  OnboardingConfigSnapshot,
  OnboardingServiceState,
  OnboardingSnapshotCollectionIssue,
  OnboardingSnapshotCollectionIssueArea,
  OnboardingSnapshotDependencies,
  OnboardingSnapshotState,
  OnboardingSurfaceRecord,
} from './types.ts';

export interface OnboardingSnapshotReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

function snapshotReadGuard(options: OnboardingSnapshotReadOptions): () => void {
  return captureNativeReadRestrictions(options);
}

async function drainSnapshotReads<T extends readonly unknown[]>(reads: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const drained = Promise.allSettled(reads);
  try { return await Promise.all(reads); }
  catch (error) { await drained; throw error; }
}

function buildConfigSnapshot(
  config: OnboardingSnapshotDependencies['config'],
): OnboardingConfigSnapshot {
  return {
    display: config.getCategory('display'),
    provider: config.getCategory('provider'),
    behavior: config.getCategory('behavior'),
    storage: config.getCategory('storage'),
    permissions: config.getCategory('permissions'),
    helper: config.getCategory('helper'),
    tools: {
      llmEnabled: config.get('tools.llmEnabled'),
      llmProvider: config.get('tools.llmProvider'),
      llmModel: config.get('tools.llmModel'),
    },
    surfaces: config.getCategory('surfaces'),
  };
}

async function buildServicesSnapshot(
  services: OnboardingSnapshotDependencies['services'],
  assertCurrent: () => void,
): Promise<{
  snapshot: {
    total: number;
    oauthProviderIds: readonly string[];
    services: readonly OnboardingServiceState[];
  };
  issues: readonly OnboardingSnapshotCollectionIssue[];
}> {
  let configs: ReturnType<OnboardingSnapshotDependencies['services']['getAll']>;
  try {
    assertCurrent();
    configs = services.getAll();
    assertCurrent();
  } catch (error) {
    assertCurrent();
    return {
      snapshot: {
        total: 0,
        oauthProviderIds: [],
        services: [],
      },
      issues: [
        {
          area: 'host',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const names = Object.keys(configs).sort((left, right) => left.localeCompare(right));
  const entryResults = await drainSnapshotReads(names.map(async (name) => {
    const config = configs[name]!;
    try {
      assertCurrent();
      const inspection = await services.inspect(name);
      assertCurrent();

      return {
        entry: {
          name,
          providerId: config.providerId ?? config.name,
          baseUrl: config.baseUrl ?? null,
          authType: config.authType,
          tokenKey: config.tokenKey,
          oauthConfigured: Boolean(config.oauth),
          hasPrimaryCredential: inspection?.hasPrimaryCredential ?? false,
          hasPasswordCredential: inspection?.hasPasswordCredential ?? false,
          hasWebhookUrl: inspection?.hasWebhookUrl ?? false,
          hasSigningSecret: inspection?.hasSigningSecret ?? false,
          hasPublicKey: inspection?.hasPublicKey ?? false,
          hasAppToken: inspection?.hasAppToken ?? false,
        } satisfies OnboardingServiceState,
        issue: null,
      };
    } catch (error) {
      assertCurrent();
      return {
        entry: {
          name,
          providerId: config.providerId ?? config.name,
          baseUrl: config.baseUrl ?? null,
          authType: config.authType,
          tokenKey: config.tokenKey,
          oauthConfigured: Boolean(config.oauth),
          hasPrimaryCredential: false,
          hasPasswordCredential: false,
          hasWebhookUrl: false,
          hasSigningSecret: false,
          hasPublicKey: false,
          hasAppToken: false,
        } satisfies OnboardingServiceState,
        issue: {
          area: 'host',
          message: `${name}: ${error instanceof Error ? error.message : String(error)}`,
        } satisfies OnboardingSnapshotCollectionIssue,
      };
    }
  }));

  assertCurrent();
  const entries = entryResults.map((result) => result.entry);
  const issues: OnboardingSnapshotCollectionIssue[] = [];
  for (const result of entryResults) {
    if (result.issue) issues.push(result.issue);
  }

  return {
    snapshot: {
      total: entries.length,
      oauthProviderIds: sortUnique(entries.filter((entry) => entry.oauthConfigured).map((entry) => entry.providerId)),
      services: entries,
    },
    issues,
  };
}



async function loadOptionalSnapshot<T>(
  area: OnboardingSnapshotCollectionIssueArea,
  loader: (() => Promise<T>) | undefined,
  fallback: T,
): Promise<{
  value: T;
  issue: OnboardingSnapshotCollectionIssue | null;
}> {
  if (!loader) return { value: fallback, issue: null };

  try {
    return {
      value: await loader(),
      issue: null,
    };
  } catch (error) {
    return {
      value: fallback,
      issue: {
        area,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function collectOnboardingSnapshot(
  deps: OnboardingSnapshotDependencies,
  options: OnboardingSnapshotReadOptions = {},
): Promise<OnboardingSnapshotState> {
  const assertCurrent = snapshotReadGuard(options);
  assertCurrent();
  const observe = async <T>(read: () => T | Promise<T>): Promise<T> => {
    assertCurrent();
    const value = await read();
    assertCurrent();
    return value;
  };
  const capturedAt = deps.clock?.() ?? Date.now();
  const config = buildConfigSnapshot(deps.config);
  const providerRouting = buildProviderRoutingSnapshot(config, getProviderIdFromModel);
  const runtimeDefaults = buildRuntimeDefaultsSnapshot(config);
  const acknowledgementResult = buildAcknowledgementSnapshot(deps, readOnboardingRuntimeState);

  const [
    subscriptionsActiveResult,
    subscriptionsPendingResult,
    authSnapshotResult,
    servicesResult,
    secretReviewResult,
    secretRecordsResult,
    surfaceResult,
    providerAccountsResult,
  ] = await drainSnapshotReads([
    loadOptionalSnapshot(
      'subscriptions-active',
      () => observe(() => deps.subscriptions.list()),
      [] as ReturnType<OnboardingSnapshotDependencies['subscriptions']['list']>,
    ),
    loadOptionalSnapshot(
      'subscriptions-pending',
      () => observe(() => deps.subscriptions.listPending()),
      [] as ReturnType<OnboardingSnapshotDependencies['subscriptions']['listPending']>,
    ),
    loadOptionalSnapshot(
      'auth',
      () => observe(() => deps.auth.inspect()),
      buildFallbackAuthSnapshot(),
    ),
    buildServicesSnapshot(deps.services, assertCurrent),
    loadOptionalSnapshot(
      'secrets-review',
      () => observe(() => deps.secrets.inspect()),
      buildFallbackSecretReview(config),
    ),
    loadOptionalSnapshot(
      'secrets-records',
      () => observe(() => deps.secrets.listDetailed()),
      [] as const,
    ),
    loadOptionalSnapshot(
      'surfaces',
      deps.surfaces ? () => observe(() => deps.surfaces!.list()) : undefined,
      [] as readonly OnboardingSurfaceRecord[],
    ),
    loadOptionalSnapshot(
      'provider-accounts',
      deps.providerAccounts ? () => observe(() => deps.providerAccounts!.loadSnapshot()) : undefined,
      null,
    ),
  ] as const);

  assertCurrent();
  const collectionIssues: OnboardingSnapshotCollectionIssue[] = [];
  if (acknowledgementResult.issue) collectionIssues.push(acknowledgementResult.issue);
  collectionIssues.push(...servicesResult.issues);
  if (subscriptionsActiveResult.issue) collectionIssues.push(subscriptionsActiveResult.issue);
  if (subscriptionsPendingResult.issue) collectionIssues.push(subscriptionsPendingResult.issue);
  if (authSnapshotResult.issue) collectionIssues.push(authSnapshotResult.issue);
  if (secretReviewResult.issue) collectionIssues.push(secretReviewResult.issue);
  if (secretRecordsResult.issue) collectionIssues.push(secretRecordsResult.issue);
  if (surfaceResult.issue) collectionIssues.push(surfaceResult.issue);
  if (providerAccountsResult.issue) collectionIssues.push(providerAccountsResult.issue);

  return {
    capturedAt,
    config,
    providerRouting,
    runtimeDefaults,
    acknowledgements: acknowledgementResult.snapshot,
    services: servicesResult.snapshot,
    subscriptions: {
      active: subscriptionsActiveResult.value,
      pending: subscriptionsPendingResult.value,
      activeProviderIds: sortUnique(subscriptionsActiveResult.value.map((entry) => entry.provider)),
      pendingProviderIds: sortUnique(subscriptionsPendingResult.value.map((entry) => entry.provider)),
    },
    secrets: {
      review: secretReviewResult.value,
      records: secretRecordsResult.value,
    },
    auth: {
      snapshot: authSnapshotResult.value,
    },
    surfaces: {
      configuredEnabledKinds: buildConfiguredSurfaceKinds(config.surfaces),
      records: sortSurfaceRecords(surfaceResult.value),
    },
    providerAccounts: providerAccountsResult.value,
    localBehaviorDiscovery: summarizeAgentBehaviorDiscovery(deps.shellPaths),
    collectionIssues,
  };
}
