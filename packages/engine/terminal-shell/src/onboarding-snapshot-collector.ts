import type { LocalAuthSnapshot } from '@goodvibes-jev/engine/platform/platform/security';
import type { SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import type {
  LocalAuthInspectionQuery,
  ServiceInspectionQuery,
  SubscriptionAccessQuery,
} from '@goodvibes-jev/engine/platform/platform/runtime/ui';
import type { OnboardingServiceState, OnboardingSurfaceRecord } from './onboarding-data-types.js';
import type { OnboardingAcknowledgementSnapshot } from './onboarding-state-types.js';
import {
  buildFallbackAuthSnapshot,
  buildFallbackSecretReview,
  buildConfiguredSurfaceKinds,
  sortSurfaceRecords,
  sortUnique,
  type buildProviderRoutingSnapshot,
  type buildRuntimeDefaultsSnapshot,
} from './onboarding-read-facts.js';
import { drainSnapshotReads, type SnapshotReadIssue } from './onboarding-snapshot-reads.js';
export interface TerminalOnboardingProviderAccount {
  readonly providerId: string;
  readonly configured: boolean;
  readonly active: boolean;
  readonly oauthReady: boolean;
  readonly pendingLogin: boolean;
  readonly availableRoutes: readonly string[];
  readonly activeRoute: string;
  readonly authFreshness: string;
  readonly apiKeyEnvVar?: string | undefined;
}
export interface TerminalOnboardingProviderAccounts {
  readonly capturedAt: number;
  readonly configuredCount: number;
  readonly issueCount: number;
  readonly providers: readonly TerminalOnboardingProviderAccount[];
}
export interface TerminalOnboardingSnapshotSources {
  readonly subscriptions: Pick<SubscriptionAccessQuery, 'list' | 'listPending'>;
  readonly auth: Pick<LocalAuthInspectionQuery, 'inspect'>;
  readonly services: Pick<ServiceInspectionQuery, 'getAll' | 'inspect'>;
  readonly secrets: Pick<SecretsManager, 'inspect' | 'listDetailed'>;
  readonly surfaces?:
    | {
        list(): readonly OnboardingSurfaceRecord[] | Promise<readonly OnboardingSurfaceRecord[]>;
      }
    | undefined;
  readonly providerAccounts?:
    | {
        loadSnapshot(): Promise<TerminalOnboardingProviderAccounts>;
      }
    | undefined;
}
type CommonReadArea =
  | 'subscriptions-active'
  | 'subscriptions-pending'
  | 'auth'
  | 'secrets-review'
  | 'secrets-records'
  | 'surfaces'
  | 'provider-accounts';
type CommonConfig = Parameters<typeof buildRuntimeDefaultsSnapshot>[0] & {
  readonly surfaces: object;
};
/** Keep product read ownership while sharing collection, fallback accounting and detached read models. */
export async function collectTerminalOnboardingSnapshot<Config extends CommonConfig, Area extends string, Extra>(
  sources: TerminalOnboardingSnapshotSources,
  captured: {
    readonly capturedAt: number;
    readonly config: Config;
    readonly providerRouting: ReturnType<typeof buildProviderRoutingSnapshot>;
    readonly runtimeDefaults: ReturnType<typeof buildRuntimeDefaultsSnapshot>;
    readonly acknowledgements: {
      readonly snapshot: OnboardingAcknowledgementSnapshot;
      readonly issue: SnapshotReadIssue<Area> | null;
    };
  },
  readers: {
    readonly loadOptionalSnapshot: <Value>(
      area: CommonReadArea,
      load: (() => Promise<Value>) | undefined,
      fallback: Value,
    ) => Promise<{
      value: Value;
      issue: SnapshotReadIssue<Area> | null;
    }>;
    readonly buildServicesSnapshot: (
      services: TerminalOnboardingSnapshotSources['services'],
      assertCurrent?: (() => void) | undefined,
    ) => Promise<{
      snapshot: {
        total: number;
        oauthProviderIds: readonly string[];
        services: readonly OnboardingServiceState[];
      };
      issues: readonly SnapshotReadIssue<Area>[];
    }>;
  },
  options: {
    readonly assertCurrent?: (() => void) | undefined;
    readonly drainOnFailure: boolean;
    readonly readExtra: () => Promise<Extra>;
  },
) {
  const assertCurrent = options.assertCurrent;
  const observe = async <Value>(read: () => Value | Promise<Value>): Promise<Value> => {
    assertCurrent?.();
    const value = await read();
    assertCurrent?.();
    return value;
  };
  const read = <Value>(operation: () => Value | Promise<Value>): Promise<Value> =>
    assertCurrent ? observe(operation) : Promise.resolve(operation());
  const pending = [
    readers.loadOptionalSnapshot(
      'subscriptions-active',
      () => read(() => sources.subscriptions.list()),
      [] as ReturnType<SubscriptionAccessQuery['list']>,
    ),
    readers.loadOptionalSnapshot(
      'subscriptions-pending',
      () => read(() => sources.subscriptions.listPending()),
      [] as ReturnType<SubscriptionAccessQuery['listPending']>,
    ),
    readers.loadOptionalSnapshot('auth', () => read(() => sources.auth.inspect()), buildFallbackAuthSnapshot()),
    readers.buildServicesSnapshot(sources.services, assertCurrent),
    readers.loadOptionalSnapshot('secrets-review', () => read(() => sources.secrets.inspect()), buildFallbackSecretReview(captured.config)),
    readers.loadOptionalSnapshot('secrets-records', () => read(() => sources.secrets.listDetailed()), [] as const),
    readers.loadOptionalSnapshot(
      'surfaces',
      sources.surfaces ? () => read(() => sources.surfaces!.list()) : undefined,
      [] as readonly OnboardingSurfaceRecord[],
    ),
    readers.loadOptionalSnapshot(
      'provider-accounts',
      sources.providerAccounts ? () => read(() => sources.providerAccounts!.loadSnapshot()) : undefined,
      null,
    ),
    options.readExtra(),
  ] as const;
  const [active, pendingSubscriptions, auth, services, secretReview, secretRecords, surfaces, accounts, extra] =
    await (options.drainOnFailure ? drainSnapshotReads(pending) : Promise.all(pending));
  assertCurrent?.();
  const collectionIssues: SnapshotReadIssue<Area>[] = [];
  if (captured.acknowledgements.issue) collectionIssues.push(captured.acknowledgements.issue);
  collectionIssues.push(...services.issues);
  for (const result of [active, pendingSubscriptions, auth, secretReview, secretRecords, surfaces, accounts]) {
    if (result.issue) collectionIssues.push(result.issue);
  }
  const authSnapshot: LocalAuthSnapshot = auth.value;
  return {
    state: {
      capturedAt: captured.capturedAt,
      config: captured.config,
      providerRouting: captured.providerRouting,
      runtimeDefaults: captured.runtimeDefaults,
      acknowledgements: captured.acknowledgements.snapshot,
      services: services.snapshot,
      subscriptions: {
        active: active.value,
        pending: pendingSubscriptions.value,
        activeProviderIds: sortUnique(active.value.map((entry) => entry.provider)),
        pendingProviderIds: sortUnique(pendingSubscriptions.value.map((entry) => entry.provider)),
      },
      secrets: { review: secretReview.value, records: secretRecords.value },
      auth: { snapshot: authSnapshot },
      surfaces: {
        configuredEnabledKinds: buildConfiguredSurfaceKinds(captured.config.surfaces),
        records: sortSurfaceRecords(surfaces.value),
      },
      providerAccounts: accounts.value,
      collectionIssues,
    },
    extra,
  };
}
