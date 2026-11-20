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
export type {
  OnboardingVerificationStatus,
  OnboardingVerificationItem,
  OnboardingVerificationResult,
} from '@goodvibes/engine/terminal-shell/onboarding-verification';
import type { OnboardingAcknowledgementSnapshot } from '@goodvibes/engine/terminal-shell/onboarding-state-types';
export type { OnboardingAcknowledgementSnapshot } from '@goodvibes/engine/terminal-shell/onboarding-state-types';
import type {
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
import type { ConfigManager, ConfigKey, GoodVibesConfig } from '@goodvibes/engine/platform/platform/config';
import type { SecretsManager } from '../../config/secrets.ts';
import type { UserAuthManager } from '@goodvibes/engine/platform/platform/security';
import type { ShellPathService } from '@/runtime/index.ts';
import type { LocalAuthInspectionQuery, ServiceInspectionQuery, SubscriptionAccessQuery } from '@/runtime/index.ts';

export type OnboardingConfigSnapshot = TerminalOnboardingConfigSnapshot<
  | 'display'
  | 'provider'
  | 'behavior'
  | 'storage'
  | 'permissions'
  | 'helper'
  | 'tools'
  | 'danger'
  | 'controlPlane'
  | 'httpListener'
  | 'web'
  | 'network'
  | 'surfaces'
  | 'service'
  | 'batch'
  | 'cloudflare'
>;

export interface OnboardingBindSettingsSnapshot {
  readonly daemonEnabled: boolean;
  readonly httpListenerEnabled: boolean;
  readonly controlPlane: GoodVibesConfig['controlPlane'];
  readonly httpListener: GoodVibesConfig['httpListener'];
  readonly web: GoodVibesConfig['web'];
  /** `daemon.connectedHost.url`: the daemon this terminal was pointed at; empty for the one on this machine. */
  readonly connectedDaemonUrl?: string;
}

export type OnboardingProviderAccountRecord = TerminalOnboardingProviderAccount;

export type OnboardingProviderAccountsSnapshot = TerminalOnboardingProviderAccountsSnapshot<OnboardingProviderAccountRecord>;

export type OnboardingSnapshotCollectionIssueArea =
  | 'services'
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
  readonly bindSettings: OnboardingBindSettingsSnapshot;
}

export type OnboardingStep1CapabilityId =
  | 'local-tui-only'
  | 'browser-access'
  | 'network-access'
  | 'webhook-events'
  | 'external-integrations'
  | 'cloudflare-batch';

export type OnboardingStep1CapabilityItem = TerminalOnboardingCapabilityItem<OnboardingStep1CapabilityId>;

export interface OnboardingStep1CapabilityFlags {
  readonly providers: boolean;
  readonly services: boolean;
  readonly subscriptions: boolean;
  readonly auth: boolean;
  readonly controlPlane: boolean;
  readonly httpListener: boolean;
  readonly web: boolean;
  readonly surfaces: boolean;
  readonly cloudflare: boolean;
}

export type OnboardingStepDerivationState = TerminalOnboardingStepDerivationState<OnboardingStep1CapabilityId>;

export type OnboardingApplyOperation = TerminalOnboardingApplyOperation<ConfigKey, 'project' | 'user' | 'daemon'>;

export type OnboardingApplyRequest = TerminalOnboardingApplyRequest<OnboardingApplyOperation>;

export type OnboardingAppliedOperation = TerminalOnboardingAppliedOperation<OnboardingApplyOperation['kind']>;

export type OnboardingSkippedOperation = TerminalOnboardingSkippedOperation<OnboardingApplyOperation['kind']>;

export type OnboardingApplyError = TerminalOnboardingApplyError<OnboardingApplyOperation['kind']>;

export type OnboardingApplyResult = TerminalOnboardingApplyResult<OnboardingApplyOperation['kind']>;

export type OnboardingSurfaceReadHelper = TerminalOnboardingSurfaceReadHelper;

export type OnboardingProviderAccountReadHelper = TerminalOnboardingProviderAccountReadHelper<OnboardingProviderAccountRecord>;

export type OnboardingShellPaths = Pick<ShellPathService, 'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'>;

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
  readonly config: Pick<ConfigManager, 'describeConfigKeySource' | 'get' | 'getRaw' | 'load' | 'reset' | 'setDynamic' | 'watchDaemonWrites'>;
  readonly secrets?: Pick<SecretsManager, 'delete' | 'deleteWriteScopeEntry' | 'get' | 'getFromScope' | 'getWriteScopeEntry' | 'inspect' | 'readWriteScopeEntries' | 'restoreWriteScopeEntriesIf' | 'set'>;
  readonly auth?: Pick<
    UserAuthManager,
    'addUser' | 'clearBootstrapCredentialFile' | 'createSession' | 'deleteUser' | 'getUser' | 'inspect' | 'restoreState' | 'revokeSession' | 'rotatePassword' | 'snapshotState'
  >;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}

export interface OnboardingVerificationDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get'>;
  readonly secrets?: Pick<SecretsManager, 'get' | 'getFromScope'>;
  readonly auth?: Pick<UserAuthManager, 'inspect'>;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}
