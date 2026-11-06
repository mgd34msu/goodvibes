import {
  createOnboardingSnapshotReadHelpers,
  captureOnboardingConfigSnapshot,
  drainSnapshotReads,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-snapshot-reads';
import { buildFallbackSecretReview } from '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';
import {
  sortUnique,
  buildProviderRoutingSnapshot,
  buildRuntimeDefaultsSnapshot,
  buildConfiguredSurfaceKinds,
  sortSurfaceRecords,
  buildFallbackAuthSnapshot,
  buildAcknowledgementSnapshot,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';

import { getProviderIdFromModel } from '../../config/provider-model.ts';
import { summarizeAgentBehaviorDiscovery } from '../../agent/behavior-discovery-summary.ts';
import { readOnboardingRuntimeState } from './state.ts';
import { captureNativeReadRestrictions } from '../read-restrictions.ts';
import type { OnboardingConfigSnapshot, OnboardingSnapshotCollectionIssue, OnboardingSnapshotCollectionIssueArea, OnboardingSnapshotDependencies, OnboardingSnapshotState, OnboardingSurfaceRecord } from './types.ts';

export interface OnboardingSnapshotReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

function snapshotReadGuard(options: OnboardingSnapshotReadOptions): () => void {
  return captureNativeReadRestrictions(options);
}

function buildConfigSnapshot(config: OnboardingSnapshotDependencies['config']): OnboardingConfigSnapshot {
  return captureOnboardingConfigSnapshot(config, [
    'display',
    'provider',
    'behavior',
    'storage',
    'permissions',
    'helper',
    'tools',
    'surfaces',
  ]);
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
    loadOptionalSnapshot('auth', () => observe(() => deps.auth.inspect()), buildFallbackAuthSnapshot()),
    buildServicesSnapshot(deps.services, assertCurrent),
    loadOptionalSnapshot('secrets-review', () => observe(() => deps.secrets.inspect()), buildFallbackSecretReview(config)),
    loadOptionalSnapshot('secrets-records', () => observe(() => deps.secrets.listDetailed()), [] as const),
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

const { buildServicesSnapshot, loadOptionalSnapshot } = createOnboardingSnapshotReadHelpers<OnboardingSnapshotCollectionIssueArea>({
  serviceArea: 'host',
  drainOnFailure: true,
  error: (error) => (error instanceof Error ? error.message : String(error)),
});
