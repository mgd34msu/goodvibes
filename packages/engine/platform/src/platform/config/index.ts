export { PostalAddressHeldError } from './postal-address.js';
export { readConsumerSetting, type ConsumerConfigReader } from './profile-fallback.js';
export type { PostalKind, PostalParts, PostalReadOptions, PreparedPostalAddress } from './postal-address.js';
/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all schema types
 * - Pure helpers that derive values from an explicit ConfigManager instance
 */

export { ConfigManager, captureConfigSelectedScalars } from './manager.js';
export type { ConfigScalarSelection, ConfigSelectedScalarGuard } from './manager.js';
// A project's turn reads the host's settings with the project as its folder (the daemon's turns in a project).
export { projectConfigView, projectFeatureFlags, projectSettingsInForce } from './project-view.js';
// The ONE settings file a project keeps for every program and the daemon.
export { projectSettingsFileOf } from './project-settings-file.js';
export { captureJudgmentFallbackSettings, validJudgmentFallbackSettings } from './judgment-fallback-settings.js';
export type { JudgmentFallbackSettings } from './schema-types-judgment.js';
export type { PreparedConfigMutation, PreparedConfigMutationTransition, PreparedConfigMutationRequest,
  PreparedConfigMutationFacts, PreparedConfigMutationDestination, PreparedConfigMutationTransitionFacts,
  PreparedConfigMutationReceipt } from './prepared-mutation.js';
export type { HostBooleanSetting, HostBooleanSettingHandle, HostBooleanSettingResolved, HostManagedSettingLocks, HostNumberSetting, HostSetting, HostSettingValue, HostStringSetting } from './host-settings.js';
export type { DeepReadonly, ConfigKeyTier, ConfigKeySource, DaemonConfigPatch } from './manager.js';
export type { ConfigChange, ConfigSetOptions, DaemonWritePending, DaemonWritePress, DaemonWriteRefusal, DaemonWriteRoute, SetResult } from './manager.js';
// Who a settings write is from (ConfigManager.setMany): the owner at their own surface, the program, or a model acting for someone.
export { agentActor, localOwnerActor, systemActor } from '@goodvibes/engine/daemon-api/http-policy';
export type { Actor } from '@goodvibes/engine/daemon-api/http-policy';
export { configKeyFacts, displaySettingValue, isProtectedConfigValue, isProjectRestrictedKey } from './config-key-facts.js';
export { readCheckpointGuardSettings, readCheckpointRegistrationSetting, type CheckpointGuardSettings } from './checkpoint-settings.js';
export type { ConfigKeyFacts } from './config-key-facts.js';
export { SHARED_CONFIG_KEYS, isSharedConfigKey } from './shared-config-tier.js';
export {
  DAEMON_OWNED_CONFIG_KEYS,
  DAEMON_OWNED_CONFIG_PREFIXES,
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  USER_LOCAL_OVERRIDE_CONFIG_KEYS,
  USER_SHARED_WINS_CONFIG_KEYS,
  configKeyScope,
  describeConfigOwnership,
  isClientOwnedConfigKey,
  isDaemonOwnedConfigKey,
  isUserLevelConfigKey,
  listDaemonOwnedConfigKeys,
  listDaemonOwnedConfigPaths,
  userTierOverlaysSurface,
} from './config-ownership.js';
export type {
  ConfigScope,
  DaemonOwnedConfigPath,
  DaemonOwnedNonSchemaConfigPath,
} from './config-ownership.js';
export {
  DEFAULT_CONTROL_PLANE_PORT,
  controlPlaneScheme,
  deriveControlPlaneBaseUrl,
  describeBaseUrlDrift,
  describeDerivedBindMismatch,
  parseDaemonOrigin,
  readConnectedDaemonOrigin,
  readControlPlaneBinding,
} from './control-plane-base-url.js';
export type { BaseUrlAudience, ControlPlaneBinding, DaemonOrigin } from './control-plane-base-url.js';
export { readDotPath, raiseReaderFloorInFile } from './shared-config-tier.js';
// Settings ingestion: what a reader does with a setting it cannot ingest, and
// the reader-version floor a migration records when it rewrites shared state.
export {
  SAFETY_GATE_CONFIG_PREFIXES,
  SettingsIngestionRefusal,
  announceIngestionNotice,
  deferIngestionNoticesToApp,
  describeIngestionNotice,
  ingestSettingsFile,
  isSafetyGateConfigKey,
  screenSettingsForIngestion,
  unreadableSettingsFileNotice,
} from './settings-ingestion.js';
export type {
  IngestSettingsOptions,
  SettingsIngestionAction,
  SettingsIngestionNotice,
  SettingsIngestionResult,
} from './settings-ingestion.js';
export {
  SETTINGS_FLOOR_MARKER_KEY,
  SWEPT_CREDENTIAL_READER_FLOOR,
  compareReaderVersions,
  describeFloorRefusal,
  raiseSettingsReaderFloor,
  readSettingsReaderFloor,
  readerIsBelowFloor,
  stripSettingsReaderFloor,
} from './settings-reader-floor.js';
export type { SettingsReaderFloor } from './settings-reader-floor.js';
export {
  DAEMON_CONFIG_ROOT,
  DAEMON_SETTINGS_FILE,
  daemonConfigPathForHome,
  readDaemonTierFile,
} from './daemon-config-tier.js';
export {
  DaemonConfigOutcomeUnknownError,
  DaemonConfigRejectedError,
  DaemonConfigOwnerApprovalPendingError,
  DaemonConfigUnreachableError,
  applyConfigWrite,
  applyDaemonConfigWrites,
  discoverDaemonEndpoint,
  readDaemonConfig,
  reapUnansweringRuntimeRecord,
  resolveConfigWriteRoute,
  resolveLiveConfigWriteRoute,
} from './daemon-config-route.js';
export type {
  ConfigWriteOutcome,
  ConfigWriteRoute,
  DaemonConfigEndpoint,
  DaemonConfigWritesOutcome,
  DaemonHeldConfigEntry,
  DaemonConfigRouterDeps,
  LocalConfigWriter,
} from './daemon-config-route.js';
export {
  createEffectiveConfigView,
  loadDaemonConfigSnapshot,
  readConfigValue,
  readEffectiveConfig,
  resolveConfigReadRoute,
} from './daemon-config-read.js';
export type {
  ConfigReadRoute,
  DaemonConfigSnapshot,
  EffectiveConfigView,
  EffectiveConfigEntry,
  LocalConfigReader,
} from './daemon-config-read.js';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, SettingAppliesWhen, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig } from './schema.js';
export { SETTING_TOPICS, UNCLAIMED_SETTINGS_SECTION, sectionOfNamespace, topicOf } from './setting-topics.js';
export type { SettingTopic, SettingTopicId, SettingSection } from './setting-topics.js';
export type { HostedInboxScreening } from './schema-types-surfaces.js';
export { DEFAULT_CONFIG, CONFIG_KEYS, CONFIG_SCHEMA, isValidConfigKey } from './schema.js';
export { ConfigError } from '../types/errors.js';
export {
  hasOverriddenGoodVibesHome,
  resolveGoodVibesDaemonHome,
  resolveGoodVibesHome,
  resolveGoodVibesHomeOwnership,
  resolveGoodVibesTreeDirectory,
} from './goodvibes-home.js';
export type { GoodVibesHomeOwnership } from './goodvibes-home.js';
export {
  carryProgramSecretsToDaemon, describeSecretsCarryForward, secretsCarryForwardRecordPath, SECRET_CARRY_PROGRAMS,
  type SecretsCarryForward, type SecretsCarryForwardOptions,
} from './secrets-carry-forward.js';
export {
  carryAgentProviderStoresToDaemon, describeProviderStoresCarryForward,
  type ProviderStoresCarryForward, type ProviderStoresCarryForwardOptions,
} from './provider-stores-carry-forward.js';

import { readFileSync } from 'fs';
import { ConfigManager } from './manager.js';
import type { GoodVibesConfig } from './schema.js';
import { getProviderIdFromModel } from '../providers/provider-model.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { effectivePermissionMode } from '../gate/presets.js';

export function getConfigSnapshot(configManager: Pick<ConfigManager, 'getRaw'>): Readonly<GoodVibesConfig> {
  return configManager.getRaw();
}

export function getConfiguredModelId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.model');
}

export function getConfiguredEmbeddingProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.embeddingProvider');
}

/**
 * The provider half of the configured `provider.model` value.
 *
 * Reads through the tolerant parser (providers/provider-model.ts), so a config
 * that holds a bare model id or a blank value still yields a provider id
 * instead of throwing the way the strict registry-key reader would.
 */
export function getConfiguredProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return getProviderIdFromModel(configManager.get('provider.model'));
}

export function isAutoApproveEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get('behavior.autoApprove');
}

/** Whether the effective session execution mode is YOLO. */
export function isEffectiveDangerMode(configManager: Pick<ConfigManager, 'get'>): boolean {
  return effectivePermissionMode(configManager.get('permissions.mode'), configManager.get('behavior.autoApprove')) === 'yolo';
}

/**
 * Minimal reader shape for {@link resolveDaemonEnabled}. Any object exposing a
 * `get(key)` that returns the relevant config value satisfies it, so both
 * the full {@link ConfigManager} and the narrow `HostServicesConfig` used by
 * bootstrap-services qualify without a circular import.
 */
export interface DaemonEnabledReader {
  get(key: 'daemon.enabled'): boolean | string | number | undefined;
}

/**
 * Whether the local session daemon is used: always. Every program uses the daemon and starts it when it is not running
 * (runtime/client/daemon-autostart.ts); `daemon.enabled` ("Use the background daemon") is retired, kept in a file only
 * for a 3.5.0 program after a rollback, and a person's "off" was carried once to "Start the daemon at login"
 * (settings-carry-forward.ts carryDaemonOffToLoginStart). Kept as the one reader every caller asks, so none reads the
 * old key itself.
 */
export function resolveDaemonEnabled(_config: DaemonEnabledReader): boolean {
  return true;
}

/**
 * Minimal reader shape for {@link resolveConnectedHostDialEnabled}.
 */
export interface ConnectedHostDialReader {
  get(key: 'daemon.connectedHost.enabled'): boolean | string | number | undefined;
}

/**
 * Resolve whether this surface may DIAL the daemon it is connected to.
 *
 * ── Why this is not `resolveDaemonEnabled` ────────────────────────────────
 *
 * `daemon.enabled` answers "does this surface adopt a session daemon of its
 * own". Dialing a host that is already running and answering is a different
 * question, and for a while one key answered both.
 *
 * On a machine with `daemon.enabled: false` and a live connected host that
 * every other caller reached without trouble, the conflation silently killed
 * the session-inputs poll (refused every two seconds, thousands of log lines an
 * hour), the conversation-rewind host registration, the approvals update
 * stream, and the hosted-conversation handoff, while the session spine, the
 * memory spine and the operator tools dialed the SAME host successfully,
 * because they never read the flag. The features that refused and the features
 * that worked disagreed about whether the daemon existed.
 *
 * Defaults to `true`, and deliberately does NOT fall back to `daemon.enabled`:
 * inheriting the old value would rebuild the exact conflation this exists to
 * end. A surface that wants no daemon contact at all sets this to `false`,
 * which is now a thing it can actually say.
 */
export function resolveConnectedHostDialEnabled(config: ConnectedHostDialReader): boolean {
  const enabled = config.get('daemon.connectedHost.enabled');
  return typeof enabled === 'boolean' ? enabled : true;
}

export function getWorkingDirectory(configManager: Pick<ConfigManager, 'getWorkingDirectory'>): string | null {
  return configManager.getWorkingDirectory();
}

const warnedSystemPromptFiles = new Set<string>();

/**
 * The contents of `provider.systemPromptFile`, or undefined when no file is
 * configured or the configured file cannot be read.
 *
 * An unreadable file degrades to "no configured system prompt" and says so at
 * warn level (once per path) rather than throwing: the setting names a file the user may have
 * since moved or deleted, and a boot that dies because of it strands the
 * session over an optional preference.
 */
export function getConfiguredSystemPrompt(configManager: Pick<ConfigManager, 'get'>): string | undefined {
  const file = configManager.get('provider.systemPromptFile');
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    // Warn once per path: this runs on every session, and the first sentence is
    // the one that tells the operator the session is running without the prompt
    // they configured.
    if (!warnedSystemPromptFiles.has(file)) {
      warnedSystemPromptFiles.add(file);
      logger.warn('Configured provider.systemPromptFile could not be read; this session runs WITHOUT it', { file, error: summarizeError(err) });
    }
    return undefined;
  }
}

export { getConfiguredApiKeys, resolveApiKeys } from './api-keys.js';
export { createOAuthLocalListener } from './oauth-local-listener.js';
export type { OAuthLocalListener, OAuthLocalListenerConfig } from './oauth-local-listener.js';
export { HelperModel, HelperRouter } from './helper-model.js';
export type {
  HelperChatOptions,
  HelperModelDeps,
  HelperTask,
  HelperUsage,
  ResolvedHelper,
} from './helper-model.js';
export * from './secret-refs.js';
export {
  GOODVIBES_URI_PREFIX,
  MalformedSecretRefError,
  describeMalformedSecretRef,
  looksLikeSecretRef,
} from './secret-ref-refusal.js';
export { createCredentialStatusProvider } from './credential-status.js';
export {
  daemonSecretKeyFor,
  isDaemonOwnedSecretKey,
  listDaemonOwnedSecretKeys,
} from './daemon-secret-keys.js';
export { defaultDaemonSecretHome } from './secrets-store-paths.js';
export {
  CREDENTIAL_SCOPE_DECLARATIONS,
  describeCredentialScope,
  findCredentialScopeDeclaration,
  isDaemonNeededSecretKey,
  listDaemonNeededKeyPrefixes,
  listExactDaemonNeededKeys,
} from './credential-scope-registry.js';
export type {
  CredentialScopeClass,
  CredentialScopeDeclaration,
} from './credential-scope-registry.js';
export {
  isDeclaredSecretBearingConfigKey,
  isSecretBearingConfigKey,
  isSecretReferenceValue,
  SECRET_BEARING_CONFIG_PATHS,
} from './secret-bearing-config-keys.js';
export {
  STRUCTURED_CREDENTIAL_CONFIG_DECLARATIONS,
  isStructuredCredentialReferenceConfigKey,
  captureStructuredCredentialReferenceConfigValue,
} from './structured-credential-config.js';
export { configKeyDescription, readCredentialKey } from './credential-key-reading.js';
export {
  describePlaintextSweep,
  secretReferenceFor,
  sweepPlaintextCredentials,
} from './plaintext-credential-sweep.js';
export type {
  PlaintextSweepEntry,
  PlaintextSweepOutcome,
  PlaintextSweepReport,
  SweepableConfig,
  SweepableSecrets,
} from './plaintext-credential-sweep.js';
export {
  SecretsManager,
  captureSecretsReadSource,
  SecretWriteCommittedError,
  SecretStoreUnreadableError,
  describeSecretWriteScope,
  resolveSecretDeleteScope,
  resolveSecretWriteScope,
  secretWriteScopeWasOverridden,
} from './secrets.js';
export type {
  ConfirmedProjectSecret,
  PreparedScopedSecretDeletion,
  PreparedScopedSecretDeletionFacts,
  SecretDeleteOptions,
  SecretDeletion,
  SecretRecord,
  SecretScope,
  SecretSource,
  SecretStorageMedium,
  SecretStorageMode,
  SecretStorageReview,
  SecretWriteOptions,
  SecretWriteTransition,
  SecretWriteTransitionFacts,
  SecretWriteEffectOwner,
  SecretsManagerOptions,
  WriteScopeEntries,
} from './secrets.js';
// A secret that reads as absent from a store this process cannot read is said as such, never as "not stored".
export { SECRET_STORE_UNREADABLE, secretStoreUnreadableSentence, unreadableSecretStore, type StoredSecretReader } from './secret-store-unreadable.js';
// The one way a product builds its credential store (the daemon home is required).
export { createRuntimeSecretsManager } from '../runtime/secrets-composition.js';
export type { DaemonSecretsCompositionInput } from '../runtime/secrets-composition.js';
export { ServiceRegistry, SERVICE_SECRET_KEY_FIELDS, SERVICE_SECRET_REFERENCE_FIELDS, captureServiceReadSource, describePendingProjectService, pendingProjectServiceLines, projectServiceRef } from './service-registry.js';
export type * from './service-registry.js';
export { SubscriptionManager, SubscriptionSessionEndedError, captureSubscriptionReadSource, sharedSubscriptionsPath, subscriptionExportForm, subscriptionState, subscriptionAuthFreshness, SUBSCRIPTION_EXPIRING_SOON_MS } from './subscriptions.js';
export type {
  OAuthProviderConfig,
  PendingSubscriptionLogin,
  ProviderSubscription,
  SubscriptionGrant,
  SubscriptionShellPaths,
  SubscriptionState,
} from './subscriptions.js';
export { observeImportFile, assertImportFileCurrent } from './prepared-import.js';
export type { ImportFileObservation } from './prepared-import.js';
export * from './subscription-auth.js';
export * from './subscription-providers.js';
export * from './subscription-sign-in.js';
export { resolveToolLLM, ToolLLM, ToolLLMUnavailableError } from './tool-llm.js';
export type {
  ResolvedToolLLM,
  ToolLLMChatOptions,
  ToolLLMDeps,
} from './tool-llm.js';

export { atomicWriteFileSync } from './atomic-write.js';
export type { AtomicWriteOptions } from './atomic-write.js';
export { withSyncFileLock } from './sync-file-lock.js';

export {
  QUARANTINE_MAX_FILES_PER_DIR,
  QUARANTINE_RETENTION_MS,
  readVersioned,
  reapQuarantinedFiles,
  setAsideNewerVersionFile,
  UNRECOGNIZED_SUFFIX,
} from './read-versioned.js';
export type {
  QuarantineReapOptions,
  QuarantineReapResult,
  ReadVersionedOptions,
  VersionMigration,
} from './read-versioned.js';

export {
  credentialReadModeFromHostMode,
  deriveCredentialAvailability,
  readClientCredentialStatus,
} from './credential-availability.js';
export type {
  CredentialAvailability,
  CredentialReadMode,
  CredentialStatusEntry,
  CredentialStatusOutcome,
} from './credential-availability.js';

export { createAtRestCipher, createDaemonCredentialStore } from './daemon-credential-store.js';
export type { AtRestCipher, DaemonCredentialStore } from './daemon-credential-store.js';

// Prepared remote SETTINGS substrate. No capture/reference conveys admission.
export { captureRemoteSettingsPrecondition, inspectRemoteSettingsPrecondition, assertRemoteSettingsPrecondition,
  applyRemoteSettingsPrecondition, resolvePreparedConfigWriteRoute, assertPreparedConfigWriteRoute } from './settings-precondition-client.js';
export type { RemoteSettingsPrecondition, RemoteSettingsPreconditionFacts, RemoteSettingsReceipt, SettingsPreconditionRequest, SettingsPreconditionReceipt } from './settings-precondition-client.js';
export { describeSettingsReceiptFailure } from './settings-owner-wire.js';

export { DEFAULT_DECISION_ROUTER_SETTINGS, captureDecisionRouterSettings } from './decision-router-settings.js';
export type { DecisionRouterSettings, DecisionRouterTarget, DecisionRouterCategory } from './decision-router-settings.js';

export { SECRET_CONFIG_KEYS, createSecretBackedConfigWriter, isSecretConfigKey, normalizeSecretKeyPart, buildGoodVibesSecretKey, buildGoodVibesSecretRef, isGoodVibesSecretReferenceValue, isMalformedGoodVibesSecretReferenceValue, getSecretWriteMedium, buildSecretBackedConfigUpdate, defaultSecretBackedScope, persistSecretBackedConfigValue } from './secret-backed-config.js';
export type { SecretBackedConfigUpdate, SecretBackedConfigManager, SecretBackedSecretStore, DaemonCredentialWriter, SecretBackedConfigRoute } from './secret-backed-config.js';
export { PAYMENTS_CVV_HANDLING_CONFIG_KEY, PAYMENTS_ADDRESS_FIELD_SUFFIXES, PAYMENTS_SYNTHETIC_CONFIG_KEYS, paymentsAddressConfigKey, paymentsAddressConfigKeys, isPaymentsSyntheticConfigKey } from './payment-config-keys.js';
export type { PaymentsAddressKind } from './payment-config-keys.js';
export { DECISION_MODEL_SET_KEYS, decisionModelSet, decisionModelSettings, type DecisionModelSettings } from './decision-model-set.js';
