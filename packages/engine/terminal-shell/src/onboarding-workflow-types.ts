import type { SecretScope } from '@goodvibes-jev/engine/sdk/platform/config';
import type {
  OnboardingNetworkMode,
  OnboardingReopenEditAcknowledgementState,
  OnboardingProviderRoutingSnapshot,
  OnboardingRuntimeDefaultsSnapshot,
  OnboardingServicesSnapshot,
  OnboardingSubscriptionsSnapshot,
  OnboardingSecretsSnapshot,
  OnboardingAuthSnapshot,
  OnboardingSurfacesSnapshot,
  OnboardingSurfaceRecord,
} from './onboarding-data-types.js';
import type { OnboardingMode, OnboardingAcknowledgementTarget, OnboardingAcknowledgementSnapshot } from './onboarding-state-types.js';
import type { SnapshotReadIssue } from './onboarding-snapshot-reads.js';
/** Platform contracts parameterize product capability vocabularies without widening authority. */
export interface TerminalOnboardingProviderAccountsSnapshot<Account> {
  readonly capturedAt: number;
  readonly configuredCount: number;
  readonly issueCount: number;
  readonly providers: readonly Account[];
}

export interface TerminalOnboardingSnapshotState<Config, Area extends string, Account> {
  readonly capturedAt: number;
  readonly config: Config;
  readonly providerRouting: OnboardingProviderRoutingSnapshot;
  readonly runtimeDefaults: OnboardingRuntimeDefaultsSnapshot;
  readonly acknowledgements: OnboardingAcknowledgementSnapshot;
  readonly services: OnboardingServicesSnapshot;
  readonly subscriptions: OnboardingSubscriptionsSnapshot;
  readonly secrets: OnboardingSecretsSnapshot;
  readonly auth: OnboardingAuthSnapshot;
  readonly surfaces: OnboardingSurfacesSnapshot;
  readonly providerAccounts: TerminalOnboardingProviderAccountsSnapshot<Account> | null;
  readonly collectionIssues: readonly SnapshotReadIssue<Area>[];
}

export interface TerminalOnboardingCapabilityItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly selected: boolean;
  readonly detail: string;
}

export interface TerminalOnboardingStepDerivationState<Id extends string> {
  readonly step1Capabilities: readonly TerminalOnboardingCapabilityItem<Id>[];
  readonly step1_5NetworkMode: OnboardingNetworkMode;
  readonly reopenEditAcknowledgements: OnboardingReopenEditAcknowledgementState;
}

export type TerminalOnboardingApplyOperation<Key extends string, Scope extends SecretScope> =
  | {
      readonly kind: 'set-config';
      readonly key: Key;
      readonly value: unknown;
      readonly scope?: 'global' | 'project';
    }
  | {
      readonly kind: 'set-secret';
      readonly key: string;
      readonly value: string;
      /**
       * Which secret tier the value is filed in. 'daemon' is the tier the
       * daemon reads with every surface closed, see
       * config/secret-config.ts#defaultSecretBackedScope.
       */
      readonly scope?: Scope;
      readonly medium: 'secure' | 'plaintext';
    }
  | {
      readonly kind: 'ensure-auth-user';
      readonly username: string;
      readonly password: string;
      readonly roles?: readonly string[];
      readonly createSession?: boolean;
      readonly retireBootstrapCredential?: boolean;
    }
  | {
      readonly kind: 'acknowledge';
      readonly target: OnboardingAcknowledgementTarget;
      readonly acknowledged: boolean;
    };

export interface TerminalOnboardingApplyRequest<Operation> {
  readonly mode: OnboardingMode;
  readonly source: string;
  readonly operations: readonly Operation[];
}

export interface TerminalOnboardingAppliedOperation<Kind extends string> {
  readonly kind: Kind;
  readonly summary: string;
}

export interface TerminalOnboardingSkippedOperation<Kind extends string> {
  readonly kind: Kind;
  readonly reason: string;
}

export interface TerminalOnboardingApplyError<Kind extends string> {
  readonly kind: Kind;
  readonly message: string;
}

export interface TerminalOnboardingApplyResult<Kind extends string> {
  readonly ok: boolean;
  readonly applied: readonly TerminalOnboardingAppliedOperation<Kind>[];
  readonly skipped: readonly TerminalOnboardingSkippedOperation<Kind>[];
  readonly errors: readonly TerminalOnboardingApplyError<Kind>[];
}

export interface TerminalOnboardingSurfaceReadHelper {
  list(): readonly OnboardingSurfaceRecord[] | Promise<readonly OnboardingSurfaceRecord[]>;
}

export interface TerminalOnboardingProviderAccountReadHelper<Account> {
  loadSnapshot(): Promise<TerminalOnboardingProviderAccountsSnapshot<Account>>;
}
