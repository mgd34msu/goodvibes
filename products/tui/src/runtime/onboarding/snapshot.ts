import {
  createOnboardingSnapshotReadHelpers,
  captureOnboardingConfigSnapshot,
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

import { getProviderIdFromModel } from '@goodvibes-jev/engine/sdk/platform/providers';
import { readOnboardingRuntimeState } from './state.ts';
import type { OnboardingConfigSnapshot, OnboardingLegacyDaemonSnapshot, OnboardingSnapshotCollectionIssue, OnboardingSnapshotCollectionIssueArea, OnboardingSnapshotDependencies, OnboardingSnapshotState, OnboardingSurfaceRecord } from './types.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

function buildConfigSnapshot(config: OnboardingSnapshotDependencies['config']): OnboardingConfigSnapshot {
  return captureOnboardingConfigSnapshot(config, [
    'display',
    'provider',
    'behavior',
    'storage',
    'permissions',
    'helper',
    'tools',
    'danger',
    'controlPlane',
    'httpListener',
    'web',
    'network',
    'surfaces',
    'service',
    'batch',
    'cloudflare',
  ]);
}

function buildFallbackLegacyDaemonSnapshot(): OnboardingLegacyDaemonSnapshot {
  return { present: false, active: false, path: '' };
}

export async function collectOnboardingSnapshot(deps: OnboardingSnapshotDependencies): Promise<OnboardingSnapshotState> {
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
    legacyDaemonResult,
  ] = await Promise.all([
    loadOptionalSnapshot(
      'subscriptions-active',
      () => Promise.resolve(deps.subscriptions.list()),
      [] as ReturnType<OnboardingSnapshotDependencies['subscriptions']['list']>,
    ),
    loadOptionalSnapshot(
      'subscriptions-pending',
      () => Promise.resolve(deps.subscriptions.listPending()),
      [] as ReturnType<OnboardingSnapshotDependencies['subscriptions']['listPending']>,
    ),
    loadOptionalSnapshot('auth', () => Promise.resolve(deps.auth.inspect()), buildFallbackAuthSnapshot()),
    buildServicesSnapshot(deps.services),
    loadOptionalSnapshot('secrets-review', () => deps.secrets.inspect(), buildFallbackSecretReview(config)),
    loadOptionalSnapshot('secrets-records', () => deps.secrets.listDetailed(), [] as const),
    loadOptionalSnapshot(
      'surfaces',
      deps.surfaces ? () => Promise.resolve(deps.surfaces!.list()) : undefined,
      [] as readonly OnboardingSurfaceRecord[],
    ),
    loadOptionalSnapshot('provider-accounts', deps.providerAccounts ? () => deps.providerAccounts!.loadSnapshot() : undefined, null),
    loadOptionalSnapshot(
      'legacy-daemon',
      deps.legacyDaemon ? () => Promise.resolve(deps.legacyDaemon!.detect()) : undefined,
      buildFallbackLegacyDaemonSnapshot(),
    ),
  ]);

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
  if (legacyDaemonResult.issue) collectionIssues.push(legacyDaemonResult.issue);

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
    bindSettings: {
      // danger.daemon (since removed, see docs/decisions/2026-07-05-daemon-by-default.md)
      // used to gate the earlier opt-in daemon posture; this site read it RAW
      // (not through resolveDaemonEnabled) so the wizard's network-mode
      // classification tracked "did the user explicitly request the legacy
      // dangerous posture" rather than "does the daemon run" (which has defaulted
      // true unconditionally since daemon-by-default landed, and would misclassify every default,
      // local-only install as server-mode if read here). Every realistic config
      // already evaluated this to `false` (unset, or an explicit `danger.daemon:
      // false` both did); the alias's removal migration preserves the one case
      // that changes real daemon behavior (explicit `false` -> `daemon.enabled:
      // false`) but does not resurrect a signal for "explicitly true", that path
      // was always a no-op for actual daemon operation. With the alias gone there
      // is no signal left to read, so this is pinned at its steady-state value.
      daemonEnabled: false,
      httpListenerEnabled: Boolean(config.danger.httpListener),
      controlPlane: config.controlPlane,
      httpListener: config.httpListener,
      web: config.web,
    },
    surfaces: {
      configuredEnabledKinds: buildConfiguredSurfaceKinds(config.surfaces),
      records: sortSurfaceRecords(surfaceResult.value),
    },
    providerAccounts: providerAccountsResult.value,
    legacyDaemon: legacyDaemonResult.value,
    collectionIssues,
  };
}

const { buildServicesSnapshot, loadOptionalSnapshot } = createOnboardingSnapshotReadHelpers<OnboardingSnapshotCollectionIssueArea>({
  serviceArea: 'services',
  drainOnFailure: false,
  error: summarizeError,
});
