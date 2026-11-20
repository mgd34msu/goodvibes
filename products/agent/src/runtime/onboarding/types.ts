import type {
  TerminalOnboardingProviderAccountsSnapshot,
  TerminalOnboardingSnapshotState,
  TerminalOnboardingCapabilityItem,
  TerminalOnboardingSurfaceReadHelper,
  TerminalOnboardingProviderAccountReadHelper,
} from '@goodvibes/engine/terminal-shell/onboarding-workflow-types';
import type { TerminalOnboardingProviderAccount } from '@goodvibes/engine/terminal-shell/onboarding-snapshot-collector';
import type { TerminalOnboardingConfigSnapshot } from '@goodvibes/engine/terminal-shell/onboarding-snapshot-reads';
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
} from '@goodvibes/engine/terminal-shell/onboarding-data-types';
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
} from '@goodvibes/engine/terminal-shell/onboarding-data-types';
import type { OnboardingAcknowledgementSnapshot } from '@goodvibes/engine/terminal-shell/onboarding-state-types';
export type { OnboardingAcknowledgementSnapshot } from '@goodvibes/engine/terminal-shell/onboarding-state-types';
import type {
  OnboardingMode,
  OnboardingAcknowledgementTarget,
  OnboardingStateScope,
} from '@goodvibes/engine/terminal-shell/onboarding-state-types';
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
} from '@goodvibes/engine/terminal-shell/onboarding-state-types';
import type { ConfigManager } from '../../config/index.ts';
import type { SecretsManager } from '../../config/secrets.ts';
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
