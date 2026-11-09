import type {
  TerminalOnboardingProviderAccountsSnapshot,
  TerminalOnboardingSnapshotState,
  TerminalOnboardingCapabilityItem,
  TerminalOnboardingStepDerivationState,
  TerminalOnboardingApplyOperation,
  TerminalOnboardingApplyRequest,
  TerminalOnboardingAppliedOperation,
  TerminalOnboardingSkippedOperation,
  TerminalOnboardingApplyError,
  TerminalOnboardingApplyResult,
  TerminalOnboardingSurfaceReadHelper,
  TerminalOnboardingProviderAccountReadHelper,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-workflow-types';
import type { TerminalOnboardingProviderAccount } from '@goodvibes-jev/engine/terminal-shell/onboarding-snapshot-collector';
import type { TerminalOnboardingConfigSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-snapshot-reads';
import type {
  OnboardingNetworkMode,
  OnboardingAcknowledgementReason,
  OnboardingProviderRoutingSnapshot,
  OnboardingServiceState,
  OnboardingServicesSnapshot,
  OnboardingSubscriptionsSnapshot,
  OnboardingSecretsSnapshot,
  OnboardingAuthSnapshot,
  OnboardingSurfaceRecord,
  OnboardingSurfacesSnapshot,
  OnboardingRuntimeDefaultsSnapshot,
  OnboardingAcknowledgementState,
  OnboardingReopenEditAcknowledgementState,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-data-types';
export type {
  OnboardingNetworkMode,
  OnboardingAcknowledgementReason,
  OnboardingProviderRoutingSnapshot,
  OnboardingServiceState,
  OnboardingServicesSnapshot,
  OnboardingSubscriptionsSnapshot,
  OnboardingSecretsSnapshot,
  OnboardingAuthSnapshot,
  OnboardingSurfaceRecord,
  OnboardingSurfacesSnapshot,
  OnboardingRuntimeDefaultsSnapshot,
  OnboardingAcknowledgementState,
  OnboardingReopenEditAcknowledgementState,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-data-types';
export type {
  OnboardingVerificationStatus,
  OnboardingVerificationItem,
  OnboardingVerificationResult,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-verification';
import type { OnboardingAcknowledgementSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
export type { OnboardingAcknowledgementSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
import type {
  OnboardingMode,
  OnboardingAcknowledgementTarget,
  OnboardingStateScope,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
export type {
  OnboardingMode,
  OnboardingAcknowledgementTarget,
  OnboardingStateScope,
  OnboardingCheckMarkerSource,
  OnboardingAcknowledgementRuntimeState,
  OnboardingCheckMarkerPayload,
  OnboardingCheckMarkerState,
  OnboardingCheckMarkersState,
  WriteOnboardingCheckMarkerOptions,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-state-types';
import type { ConfigManager, ConfigKey } from '../../config/index.ts';
import type { SecretsManager } from '../../config/secrets.ts';
import type { LegacyFeatureConfigKey } from '../feature-enablement.ts';
import type { UserAuthManager } from '@goodvibes-jev/engine/platform/platform/security';
import type { ShellPathService } from '@/runtime/index.ts';
import type { LocalAuthInspectionQuery, ServiceInspectionQuery, SubscriptionAccessQuery } from '@/runtime/index.ts';
import type { AgentBehaviorDiscoverySnapshot } from '../../agent/behavior-discovery-summary.ts';

export type OnboardingConfigSnapshot = TerminalOnboardingConfigSnapshot<
  'display' | 'provider' | 'behavior' | 'storage' | 'permissions' | 'helper' | 'tools' | 'surfaces'
>;

export type OnboardingProviderAccountRecord = Omit<TerminalOnboardingProviderAccount, 'apiKeyEnvVar'>;

export type OnboardingProviderAccountsSnapshot = TerminalOnboardingProviderAccountsSnapshot<OnboardingProviderAccountRecord>;

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

export interface OnboardingSnapshotState extends TerminalOnboardingSnapshotState<
  OnboardingConfigSnapshot,
  OnboardingSnapshotCollectionIssueArea,
  OnboardingProviderAccountRecord
> {
  readonly localBehaviorDiscovery: AgentBehaviorDiscoverySnapshot;
}

export type OnboardingStep1CapabilityId =
  | 'operator-terminal'
  | 'provider-access'
  | 'agent-knowledge'
  | 'local-behavior'
  | 'communication-channels'
  | 'automation-review'
  | 'tui-delegation';

export type OnboardingStep1CapabilityItem = TerminalOnboardingCapabilityItem<OnboardingStep1CapabilityId>;

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

export type OnboardingStepDerivationState = TerminalOnboardingStepDerivationState<OnboardingStep1CapabilityId>;

export type OnboardingApplyOperation =
  | TerminalOnboardingApplyOperation<ConfigKey | LegacyFeatureConfigKey, 'project' | 'user'>
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

export type OnboardingApplyRequest = TerminalOnboardingApplyRequest<OnboardingApplyOperation>;

export type OnboardingAppliedOperation = TerminalOnboardingAppliedOperation<OnboardingApplyOperation['kind']>;

export type OnboardingSkippedOperation = TerminalOnboardingSkippedOperation<OnboardingApplyOperation['kind']>;

export type OnboardingApplyError = TerminalOnboardingApplyError<OnboardingApplyOperation['kind']>;

export type OnboardingApplyResult = TerminalOnboardingApplyResult<OnboardingApplyOperation['kind']>;

export type OnboardingSurfaceReadHelper = TerminalOnboardingSurfaceReadHelper;

export type OnboardingProviderAccountReadHelper = TerminalOnboardingProviderAccountReadHelper<OnboardingProviderAccountRecord>;

export type OnboardingShellPaths = Pick<ShellPathService, 'homeDirectory' | 'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'>;

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
