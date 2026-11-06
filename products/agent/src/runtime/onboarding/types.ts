import type { OnboardingNetworkMode, OnboardingAcknowledgementReason, OnboardingProviderRoutingSnapshot, OnboardingServiceState, OnboardingServicesSnapshot, OnboardingSubscriptionsSnapshot, OnboardingSecretsSnapshot, OnboardingAuthSnapshot, OnboardingSurfaceRecord, OnboardingSurfacesSnapshot, OnboardingRuntimeDefaultsSnapshot, OnboardingAcknowledgementState, OnboardingReopenEditAcknowledgementState } from '@goodvibes-jev/engine/terminal-shell/onboarding-data-types';
export type { OnboardingNetworkMode, OnboardingAcknowledgementReason, OnboardingProviderRoutingSnapshot, OnboardingServiceState, OnboardingServicesSnapshot, OnboardingSubscriptionsSnapshot, OnboardingSecretsSnapshot, OnboardingAuthSnapshot, OnboardingSurfaceRecord, OnboardingSurfacesSnapshot, OnboardingRuntimeDefaultsSnapshot, OnboardingAcknowledgementState, OnboardingReopenEditAcknowledgementState } from '@goodvibes-jev/engine/terminal-shell/onboarding-data-types';
export type { OnboardingVerificationStatus, OnboardingVerificationItem, OnboardingVerificationResult } from '@goodvibes-jev/engine/terminal-shell/onboarding-verification';
import type { OnboardingAcknowledgementSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
export type { OnboardingAcknowledgementSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
import type { OnboardingMode, OnboardingAcknowledgementTarget, OnboardingStateScope } from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
export type { OnboardingMode, OnboardingAcknowledgementTarget, OnboardingStateScope, OnboardingCheckMarkerSource, OnboardingAcknowledgementRuntimeState, OnboardingCheckMarkerPayload, OnboardingCheckMarkerState, OnboardingCheckMarkersState, WriteOnboardingCheckMarkerOptions } from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
import type { ConfigManager, ConfigKey, GoodVibesConfig } from '../../config/index.ts';
import type { SecretsManager, SecretRecord, SecretStorageReview } from '../../config/secrets.ts';
import type { LegacyFeatureConfigKey } from '../feature-enablement.ts';
import type { LocalAuthSnapshot, UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import type { ShellPathService } from '@/runtime/index.ts';
import type {
  LocalAuthInspectionQuery,
  ServiceInspectionQuery,
  SubscriptionAccessQuery,
} from '@/runtime/index.ts';
import type { AgentBehaviorDiscoverySnapshot } from '../../agent/behavior-discovery-summary.ts';







export interface OnboardingConfigSnapshot {
  readonly display: GoodVibesConfig['display'];
  readonly provider: GoodVibesConfig['provider'];
  readonly behavior: GoodVibesConfig['behavior'];
  readonly storage: GoodVibesConfig['storage'];
  readonly permissions: GoodVibesConfig['permissions'];
  readonly helper: GoodVibesConfig['helper'];
  readonly tools: Pick<GoodVibesConfig['tools'], 'llmEnabled' | 'llmProvider' | 'llmModel'>;
  readonly surfaces: GoodVibesConfig['surfaces'];
}

















export interface OnboardingProviderAccountRecord {
  readonly providerId: string;
  readonly configured: boolean;
  readonly active: boolean;
  readonly oauthReady: boolean;
  readonly pendingLogin: boolean;
  readonly availableRoutes: readonly string[];
  readonly activeRoute: string;
  readonly authFreshness: string;
}

export interface OnboardingProviderAccountsSnapshot {
  readonly capturedAt: number;
  readonly configuredCount: number;
  readonly issueCount: number;
  readonly providers: readonly OnboardingProviderAccountRecord[];
}





export type OnboardingSnapshotCollectionIssueArea =
  | 'host'
  | 'subscriptions-active'
  | 'subscriptions-pending'
  | 'auth'
  | 'secrets-review'
  | 'secrets-records'
  | 'surfaces'
  | 'provider-accounts'
  | 'acknowledgements';

export interface OnboardingSnapshotCollectionIssue {
  readonly area: OnboardingSnapshotCollectionIssueArea;
  readonly message: string;
}

export interface OnboardingSnapshotState {
  readonly capturedAt: number;
  readonly config: OnboardingConfigSnapshot;
  readonly providerRouting: OnboardingProviderRoutingSnapshot;
  readonly runtimeDefaults: OnboardingRuntimeDefaultsSnapshot;
  readonly acknowledgements: OnboardingAcknowledgementSnapshot;
  readonly services: OnboardingServicesSnapshot;
  readonly subscriptions: OnboardingSubscriptionsSnapshot;
  readonly secrets: OnboardingSecretsSnapshot;
  readonly auth: OnboardingAuthSnapshot;
  readonly surfaces: OnboardingSurfacesSnapshot;
  readonly providerAccounts: OnboardingProviderAccountsSnapshot | null;
  readonly localBehaviorDiscovery: AgentBehaviorDiscoverySnapshot;
  readonly collectionIssues: readonly OnboardingSnapshotCollectionIssue[];
}

export type OnboardingStep1CapabilityId =
  | 'operator-terminal'
  | 'provider-access'
  | 'agent-knowledge'
  | 'local-behavior'
  | 'communication-channels'
  | 'automation-review'
  | 'tui-delegation';

export interface OnboardingStep1CapabilityItem {
  readonly id: OnboardingStep1CapabilityId;
  readonly label: string;
  readonly selected: boolean;
  readonly detail: string;
}

export interface OnboardingStep1CapabilityFlags {
  readonly providerAccess: boolean;
  readonly subscriptions: boolean;
  readonly auth: boolean;
  readonly agentKnowledge: boolean;
  readonly localBehavior: boolean;
  readonly communicationChannels: boolean;
  readonly automationReview: boolean;
  readonly tuiDelegation: boolean;
}





export interface OnboardingStepDerivationState {
  readonly step1Capabilities: readonly OnboardingStep1CapabilityItem[];
  readonly step1_5NetworkMode: OnboardingNetworkMode;
  readonly reopenEditAcknowledgements: OnboardingReopenEditAcknowledgementState;
}

export type OnboardingApplyOperation =
  | {
      readonly kind: 'set-config';
      readonly key: ConfigKey | LegacyFeatureConfigKey;
      readonly value: unknown;
      readonly scope?: 'global' | 'project';
    }
  | {
      readonly kind: 'set-secret';
      readonly key: string;
      readonly value: string;
      readonly scope?: 'project' | 'user';
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
    }
  | {
      readonly kind: 'create-agent-profile';
      readonly name: string;
      readonly templateId?: string;
    }
  | {
      readonly kind: 'select-agent-profile';
      readonly name: string;
    }
  | {
      readonly kind: 'create-local-note';
      readonly title: string;
      readonly body: string;
      readonly tags?: readonly string[];
    }
  | {
      readonly kind: 'create-local-persona';
      readonly name: string;
      readonly description: string;
      readonly body: string;
      readonly activate?: boolean;
    }
  | {
      readonly kind: 'create-local-skill';
      readonly name: string;
      readonly description: string;
      readonly procedure: string;
      readonly enabled?: boolean;
    }
  | {
      readonly kind: 'create-local-routine';
      readonly name: string;
      readonly description: string;
      readonly steps: string;
      readonly enabled?: boolean;
    };

export interface OnboardingApplyRequest {
  readonly mode: OnboardingMode;
  readonly source: string;
  readonly operations: readonly OnboardingApplyOperation[];
}

export interface OnboardingAppliedOperation {
  readonly kind: OnboardingApplyOperation['kind'];
  readonly summary: string;
}

export interface OnboardingSkippedOperation {
  readonly kind: OnboardingApplyOperation['kind'];
  readonly reason: string;
}

export interface OnboardingApplyError {
  readonly kind: OnboardingApplyOperation['kind'];
  readonly message: string;
}

export interface OnboardingApplyResult {
  readonly ok: boolean;
  readonly applied: readonly OnboardingAppliedOperation[];
  readonly skipped: readonly OnboardingSkippedOperation[];
  readonly errors: readonly OnboardingApplyError[];
}





export interface OnboardingSurfaceReadHelper {
  list(): readonly OnboardingSurfaceRecord[] | Promise<readonly OnboardingSurfaceRecord[]>;
}

export interface OnboardingProviderAccountReadHelper {
  loadSnapshot(): Promise<OnboardingProviderAccountsSnapshot>;
}

export type OnboardingShellPaths = Pick<
  ShellPathService,
  'homeDirectory' | 'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'
>;

export interface OnboardingSnapshotDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly subscriptions: Pick<SubscriptionAccessQuery, 'list' | 'listPending' | 'get' | 'getPending'>;
  readonly secrets: Pick<SecretsManager, 'inspect' | 'listDetailed'>;
  readonly auth: Pick<LocalAuthInspectionQuery, 'inspect'>;
  readonly services: Pick<ServiceInspectionQuery, 'getAll' | 'inspect'>;
  readonly surfaces?: OnboardingSurfaceReadHelper;
  readonly providerAccounts?: OnboardingProviderAccountReadHelper;
  readonly shellPaths?: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}

export interface OnboardingApplyDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get' | 'getCategory' | 'getRaw' | 'load' | 'mergeCategory' | 'setDynamic'>;
  readonly secrets?: Pick<SecretsManager, 'delete' | 'get' | 'inspect' | 'set'>;
  readonly auth?: Pick<UserAuthManager, 'inspect'>;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}

export interface OnboardingVerificationDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly secrets?: Pick<SecretsManager, 'get'>;
  readonly auth?: Pick<UserAuthManager, 'inspect'>;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}
