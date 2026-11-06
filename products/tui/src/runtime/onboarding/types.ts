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
import type { ConfigManager, ConfigKey, GoodVibesConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import type { SecretsManager } from '../../config/secrets.ts';
import type { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
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
}

/**
 * Wizard wiring: read-only detection of a legacy `goodvibes-daemon.service`
 * systemd unit (see `../legacy-daemon-migration.ts`'s `LegacyUnitInfo`), carried
 * on the snapshot so the Network step can show the guided migration action only
 * when there is actually something to migrate. Never implies anything was
 * touched, detection only.
 */
export interface OnboardingLegacyDaemonSnapshot {
  readonly present: boolean;
  readonly active: boolean;
  readonly path: string;
  /**
   * Follow-up: the unit name this tool actually manages on this host,
   * resolved from the `service.serviceName` config key at snapshot-collection
   * time (`resolveConfiguredServiceName`, `../legacy-daemon-migration.ts`),
   * so the wizard's detection banner names the real unit instead of the
   * hardcoded default. Optional so snapshots built without config access
   * (fallbacks, older fixtures) stay valid; readers fall back to
   * `MANAGED_SERVICE_NAME`.
   */
  readonly trackedServiceName?: string;
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
  /**
   * The secrets-store key this provider reads its API key from, its declared
   * auth env var, read from the live provider's registration-time auth state.
   * Present only for providers that accept an API key; absent for keyless /
   * subscription-only providers. Used to offer provider-agnostic key entry in
   * onboarding, and as the storage key when the entered value is saved.
   */
  readonly apiKeyEnvVar?: string;
}

export interface OnboardingProviderAccountsSnapshot {
  readonly capturedAt: number;
  readonly configuredCount: number;
  readonly issueCount: number;
  readonly providers: readonly OnboardingProviderAccountRecord[];
}

export type OnboardingSnapshotCollectionIssueArea =
  | 'services'
  | 'subscriptions-active'
  | 'subscriptions-pending'
  | 'auth'
  | 'secrets-review'
  | 'secrets-records'
  | 'surfaces'
  | 'provider-accounts'
  | 'acknowledgements'
  | 'legacy-daemon';

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
  readonly bindSettings: OnboardingBindSettingsSnapshot;
  readonly surfaces: OnboardingSurfacesSnapshot;
  readonly providerAccounts: OnboardingProviderAccountsSnapshot | null;
  readonly legacyDaemon: OnboardingLegacyDaemonSnapshot;
  readonly collectionIssues: readonly OnboardingSnapshotCollectionIssue[];
}

export type OnboardingStep1CapabilityId =
  | 'local-tui-only'
  | 'browser-access'
  | 'network-access'
  | 'webhook-events'
  | 'external-integrations'
  | 'cloudflare-batch';

export interface OnboardingStep1CapabilityItem {
  readonly id: OnboardingStep1CapabilityId;
  readonly label: string;
  readonly selected: boolean;
  readonly detail: string;
}

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

export interface OnboardingStepDerivationState {
  readonly step1Capabilities: readonly OnboardingStep1CapabilityItem[];
  readonly step1_5NetworkMode: OnboardingNetworkMode;
  readonly reopenEditAcknowledgements: OnboardingReopenEditAcknowledgementState;
}

export type OnboardingApplyOperation =
  | {
      readonly kind: 'set-config';
      readonly key: ConfigKey;
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
      readonly scope?: 'project' | 'user' | 'daemon';
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

export interface WizardProgressPayload {
  readonly version: 1;
  readonly savedAt: number;
  readonly mode: OnboardingMode;
  readonly stepIndex: number;
  /** Serialised Map<fieldId, boolean> entries */
  readonly toggleState: ReadonlyArray<readonly [string, boolean]>;
  /** Serialised Map<fieldId, string> entries */
  readonly radioState: ReadonlyArray<readonly [string, string]>;
  /** Serialised Map<fieldId, string> entries */
  readonly textState: ReadonlyArray<readonly [string, string]>;
}

export interface WizardProgressState {
  readonly path: string;
  readonly exists: boolean;
  readonly payload: WizardProgressPayload | null;
  readonly parseError?: string;
}

export interface OnboardingSurfaceReadHelper {
  list(): readonly OnboardingSurfaceRecord[] | Promise<readonly OnboardingSurfaceRecord[]>;
}

export interface OnboardingProviderAccountReadHelper {
  loadSnapshot(): Promise<OnboardingProviderAccountsSnapshot>;
}

export interface OnboardingLegacyDaemonReadHelper {
  detect(): OnboardingLegacyDaemonSnapshot | Promise<OnboardingLegacyDaemonSnapshot>;
}

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
  readonly legacyDaemon?: OnboardingLegacyDaemonReadHelper;
  readonly shellPaths?: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}

export interface OnboardingApplyDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get' | 'getRaw' | 'load' | 'setDynamic'>;
  readonly secrets?: Pick<SecretsManager, 'delete' | 'get' | 'inspect' | 'set'>;
  readonly auth?: Pick<
    UserAuthManager,
    'addUser' | 'clearBootstrapCredentialFile' | 'createSession' | 'deleteUser' | 'getUser' | 'inspect' | 'revokeSession' | 'rotatePassword'
  >;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}

export interface OnboardingVerificationDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get'>;
  readonly secrets?: Pick<SecretsManager, 'get'>;
  readonly auth?: Pick<UserAuthManager, 'inspect'>;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}
