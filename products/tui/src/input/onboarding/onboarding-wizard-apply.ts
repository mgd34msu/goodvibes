import { normalizePermissionMode } from '@goodvibes/engine/platform/platform/gate';
import { DEFAULT_CONFIG } from '@goodvibes/engine/platform/platform/config';
import type { OnboardingAcknowledgementTarget, OnboardingApplyOperation, OnboardingApplyRequest } from '../../runtime/onboarding/index.ts';
import { formatProviderModel } from '@goodvibes/engine/platform/platform/providers';
import { featureEnablementWrite } from '@goodvibes/engine/terminal-shell';
import {
  buildCloudflareApiTokenRef,
  buildCloudflareOperationalTokenRef,
  getCloudflareBatchMode,
  getCloudflareComponentSelection,
  getCloudflareSetupSource,
  shouldShowCloudflareStep,
} from './onboarding-wizard-cloudflare.ts';
import {
  EXTERNAL_SURFACE_SPECS,
  getExternalSurfaceAutoStartDefaultValue,
  getExternalSurfaceAutoStartFieldId,
  isExternalSurfaceSelectedByDefault,
} from './onboarding-wizard-external-surfaces.ts';
import { adoptedDaemonScheme, DAEMON_SOURCE_FIELD_ID, getDaemonSource } from './onboarding-wizard-network-adopt.ts';
import { applyFeatureUnitOperations, dropUnchangedConfigOperations } from './onboarding-feature-units.ts';
import { adoptedDaemonUrl, buildGoodVibesSecretKey, buildGoodVibesSecretRef, isSecretReferenceValue } from './onboarding-wizard-helpers.ts';
import { deriveProviderKeyCaptureTargets, providerKeyFieldId } from '../../runtime/onboarding/provider-key-capture.ts';
import type { OnboardingWizardControllerLike } from './onboarding-wizard-types.ts';

export function buildOnboardingApplyRequest(controller: OnboardingWizardControllerLike): OnboardingApplyRequest {
    const operations: OnboardingApplyOperation[] = [];
    // Accumulates feature-flag state that onboarding selections require, so the
    // written config actually takes effect (e.g. behavior.hitlMode is inert unless
    // hitl-ux-modes is on) and so a default-on feature the user turned OFF in a
    // feature step is persisted as a disabled override. Flushed once, after the
    // surface flags, at the end of the apply build so every gating flag is set in
    // one batch. A later write for the same flag id wins (surface enables are
    // authoritative for the network-exposing flags they own).
    const featureFlagOverrides = new Map<string, 'enabled' | 'disabled'>();

    const setConfig = (
      key: Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'],
      value: unknown,
    ): void => {
      operations.push({ kind: 'set-config', key, value });
    };
    // Only a form that shows an acknowledgement records it: another topic's Save leaves it as it is.
    const shownFieldIds = new Set(controller.steps.flatMap((step) => step.fields.map((field) => field.id)));
    const acknowledge = (target: OnboardingAcknowledgementTarget, fieldId: string): void => {
      if (!shownFieldIds.has(fieldId)) return;
      operations.push({
        kind: 'acknowledge',
        target,
        acknowledged: controller.getBooleanFieldValue(fieldId, false),
      });
    };
    // Every credential the first-run wizard captures is one the DAEMON executes
    // with: model provider API keys (the daemon runs the model), the Cloudflare
    // API token, and the masked fields of the external surfaces, all of which
    // live under daemon-owned `surfaces.*` config paths. So they all go to the
    // daemon tier, which is the one tier every surface AND the daemon read.
    //
    // 'project', what this used to pass, filed them under whatever directory
    // the wizard happened to be run from. Run the wizard in ~/code/foo and the
    // daemon, which has no idea that directory exists, found nothing; run it
    // again elsewhere and the first setup silently stopped applying. First-run
    // setup is exactly the moment where "configure once, works everywhere" has
    // to hold.
    const setSecret = (key: string, value: string): void => {
      if (value.length === 0) return;
      const medium = controller.getSelectedSecretMedium();
      operations.push({
        kind: 'set-secret',
        key,
        value,
        scope: 'daemon',
        medium,
      });
    };
    const setMaskedConfig = (
      key: Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'],
      value: string,
    ): void => {
      if (value.length === 0 || isSecretReferenceValue(value)) {
        setConfig(key, value);
        return;
      }

      const secretKey = buildGoodVibesSecretKey(key);
      setSecret(secretKey, value);
      setConfig(key, buildGoodVibesSecretRef(secretKey));
    };

    // No form makes the account that signs in: Devices and network, Addresses and ports (`a`) does.
    // No form writes how this computer is reached either (the service, the control plane, its listeners, their binds
    // and the web UI): every setup form writes only the settings it shows and the person changed. Those are changed on
    // Devices and network, Addresses and ports, the one control for them (the four network topics open it).

    // Which daemon this terminal dials is its own setting, apart from how a daemon on
    // this machine binds: connecting to an existing one points there, starting one here clears it.
    // Only the form that shows the choice writes it.
    if (shownFieldIds.has(DAEMON_SOURCE_FIELD_ID)) {
      setConfig('daemon.connectedHost.url', getDaemonSource(controller) === 'adopt' ? readAdoptedDaemonUrl(controller) : '');
    }

    // Every write below comes from a field this form shows (a form writes only what it shows and the person changed;
    // the apply then drops every write equal to what was read).
    const shows = (fieldId: string): boolean => shownFieldIds.has(fieldId);
    const defaultModel = controller.modelSelectionState.get('main');
    if (controller.topic === 'model' && defaultModel && defaultModel.enabled !== false && defaultModel.providerId.length > 0 && defaultModel.modelId.length > 0) {
      setConfig('provider.model', formatProviderModel(defaultModel.providerId, defaultModel.modelId));
    }
    if (shows('default-model.reasoning')) setConfig('provider.reasoningEffort', controller.getStringFieldValue('default-model.reasoning', controller.runtimeSnapshot?.providerRouting.primaryReasoningEffort ?? 'medium'));
    // behavior.hitlMode IS the enablement key of the hitl-ux-modes capability
    // (active for quiet/balanced/operator, off only at 'off'), so the write
    // carries the enablement, no separate gating write exists.
    if (shows('experience.hitl')) setConfig('behavior.hitlMode', controller.getStringFieldValue('experience.hitl', controller.runtimeSnapshot?.runtimeDefaults.behavior.hitlMode ?? 'balanced'));
    if (shows('experience.guidance')) setConfig('behavior.guidanceMode', controller.getStringFieldValue('experience.guidance', controller.runtimeSnapshot?.runtimeDefaults.behavior.guidanceMode ?? 'minimal'));
    if (shows('experience.permissions')) setConfig('permissions.mode', normalizePermissionMode(controller.getStringFieldValue('experience.permissions', controller.runtimeSnapshot?.runtimeDefaults.permissionsMode ?? 'jev-decides')));
    if (shows('external-services.secret-policy')) setConfig('storage.secretPolicy', controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure'));

    // Provider-agnostic key capture: store each entered key under the provider's
    // own declared secret key. Empty fields are skipped (setSecret no-ops), so
    // a blank field keeps any existing key untouched.
    for (const target of deriveProviderKeyCaptureTargets(controller.runtimeSnapshot?.providerAccounts?.providers)) {
      setSecret(target.apiKeyEnvVar, controller.getStringFieldValue(providerKeyFieldId(target.providerId), ''));
    }

    if (controller.topic === 'cloudflare' && shouldShowCloudflareStep(controller)) {
      addCloudflareOperations(controller, operations, setSecret);
    }

    const externalIntegrations = controller.isCapabilitySelected('external-integrations');
    const enabledExternalSurfaceIds: string[] = [];
    // The chat apps are the chat-apps form's: no other form writes them.
    for (const surface of controller.topic === 'chat-apps' ? EXTERNAL_SURFACE_SPECS : []) {
      const selected = externalIntegrations
        && controller.getBooleanFieldValue(
          surface.enabledFieldId,
          isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
        );
      const autoStart = selected
        && controller.getStringFieldValue(
          getExternalSurfaceAutoStartFieldId(surface),
          getExternalSurfaceAutoStartDefaultValue(surface, controller.runtimeSnapshot),
        ) === 'yes';
      setConfig(surface.enabledConfigKey, autoStart);
      if (!selected) continue;
      enabledExternalSurfaceIds.push(surface.id);

      for (const setupField of surface.fields) {
        const fallback = setupField.defaultValue(controller.runtimeSnapshot);
        if (setupField.valueType === 'number') {
          setConfig(
            setupField.configKey,
            controller.getNumberFieldValue(
              setupField.id,
              setupField.defaultNumber ?? (Number.parseInt(fallback, 10) || 0),
              setupField.min,
              setupField.max,
            ),
          );
          continue;
        }

        const value = controller.getStringFieldValue(setupField.id, fallback);
        if (setupField.kind === 'masked') setMaskedConfig(setupField.configKey, value);
        else setConfig(setupField.configKey, value);
      }
    }
    // Feature units from the guided feature steps (safety, memory & context,
    // telemetry, automation, provider, advanced): enable/disable each feature
    // the user changed from its default and write its chosen sub-options.
    // Only the features this form shows.
    applyFeatureUnitOperations(controller, setConfig, featureFlagOverrides, shownFieldIds);
    // Each selection lands as a plain domain-settings write on the feature's
    // real enablement key (e.g. sandbox.enabled, controlPlane.gateway).
    for (const flagId of [...featureFlagOverrides.keys()].sort((left, right) => left.localeCompare(right))) {
      const write = featureEnablementWrite(flagId, featureFlagOverrides.get(flagId)! === 'enabled');
      if (write) setConfig(write.key, write.value);
    }

    acknowledge('providers', 'providers.reviewed');
    acknowledge('subscriptions', 'accounts.subscriptions');

    // Fields start from the saved settings; a write equal to what was read is
    // not a change, so it is left out and a setting tuned elsewhere is kept.
    const changed = dropUnchangedConfigOperations(controller, operations);
    return {
      mode: controller.mode,
      source: 'wizard',
      // The chat-apps form (the Channels row's "set it up") saves the chat apps chosen on it and nothing else, as its
      // Save says: no exposure, service, model, mode or feature setting. An app that needs inbound webhooks says so on
      // its form; the listener is turned on in Devices and network, Addresses and ports.
      operations: controller.topic === 'chat-apps' ? chatAppOperationsOnly(changed, enabledExternalSurfaceIds) : changed,
    };
  }

/** The writes of the chosen chat apps only: each app's switch and its own fields, and the secrets those fields hold. */
function chatAppOperationsOnly(operations: readonly OnboardingApplyOperation[], chosen: readonly string[]): OnboardingApplyOperation[] {
  const keys = new Set<string>();
  for (const surface of EXTERNAL_SURFACE_SPECS) {
    if (!chosen.includes(surface.id)) continue;
    keys.add(surface.enabledConfigKey);
    for (const field of surface.fields) keys.add(field.configKey);
  }
  const secrets = new Set([...keys].map((key) => buildGoodVibesSecretKey(key)));
  return operations.filter((operation) => (operation.kind === 'set-config' && keys.has(operation.key))
    || (operation.kind === 'set-secret' && secrets.has(operation.key)));
}

function addCloudflareOperations(
  controller: OnboardingWizardControllerLike,
  operations: OnboardingApplyOperation[],
  setSecret: (key: string, value: string) => void,
): void {
    const setConfig = (
      key: Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'],
      value: unknown,
    ): void => {
      operations.push({ kind: 'set-config', key, value });
    };

    const config = controller.runtimeSnapshot?.config.cloudflare;
    const defaults = DEFAULT_CONFIG.cloudflare;
    // A name or limit with a default is written only when it differs from the
    // default (or replaces a non-default value), so a later change of the
    // default reaches everyone who kept it.
    type DefaultedKey = 'workerName' | 'workerCron' | 'queueName' | 'deadLetterQueueName' | 'tunnelName'
      | 'kvNamespaceName' | 'durableObjectNamespaceName' | 'r2BucketName' | 'secretsStoreName';
    const setDefaulted = (key: DefaultedKey, fieldId: string): void => {
      const current = config?.[key];
      const value = controller.getStringFieldValue(fieldId, current ?? defaults[key]);
      if (value !== defaults[key] || (current !== undefined && current !== defaults[key])) setConfig(`cloudflare.${key}`, value);
    };
    const enabledDefault = controller.isCapabilitySelected('cloudflare-batch') || config?.enabled === true;
    const enabled = controller.getBooleanFieldValue('cloudflare.enabled', enabledDefault);
    const components = getCloudflareComponentSelection(controller);
    const batchMode = enabled ? getCloudflareBatchMode(controller) : 'off';
    const setupSource = getCloudflareSetupSource(controller);
    const existingApiTokenRef = config?.apiTokenRef ?? '';
    let apiTokenRef = existingApiTokenRef;

    if (!enabled) {
      setConfig('cloudflare.enabled', false);
      setConfig('batch.mode', 'off');
      setConfig('batch.queueBackend', 'local');
      return;
    }

    if (setupSource === 'operational-env') {
      apiTokenRef = buildCloudflareApiTokenRef(
        controller.getStringFieldValue('cloudflare.operational-env-name', 'CLOUDFLARE_API_TOKEN'),
      );
    } else if (setupSource === 'operational-token') {
      const token = controller.getStringFieldValue('cloudflare.operational-token', '');
      if (token.length > 0) {
        setSecret('CLOUDFLARE_API_TOKEN', token);
        apiTokenRef = buildCloudflareOperationalTokenRef();
      }
    }

    setConfig('cloudflare.enabled', true);
    setConfig('cloudflare.freeTierMode', controller.getStringFieldValue('cloudflare.free-tier-mode', config?.freeTierMode === false ? 'no' : 'yes') === 'yes');
    setConfig('cloudflare.accountId', controller.getStringFieldValue('cloudflare.account-id', config?.accountId ?? ''));
    setConfig('cloudflare.apiTokenRef', apiTokenRef);
    setConfig('cloudflare.zoneId', controller.getStringFieldValue('cloudflare.zone-id', config?.zoneId ?? ''));
    setConfig('cloudflare.zoneName', controller.getStringFieldValue('cloudflare.zone-name', config?.zoneName ?? ''));
    setDefaulted('workerName', 'cloudflare.worker-name');
    setConfig('cloudflare.workerSubdomain', controller.getStringFieldValue('cloudflare.worker-subdomain', config?.workerSubdomain ?? ''));
    setConfig('cloudflare.workerHostname', controller.getStringFieldValue('cloudflare.worker-hostname', config?.workerHostname ?? ''));
    setConfig('cloudflare.workerBaseUrl', controller.getStringFieldValue('cloudflare.worker-base-url', config?.workerBaseUrl ?? ''));
    setConfig('cloudflare.daemonBaseUrl', controller.getStringFieldValue('cloudflare.daemon-base-url', config?.daemonBaseUrl ?? ''));
    setConfig('cloudflare.daemonHostname', controller.getStringFieldValue('cloudflare.daemon-hostname', config?.daemonHostname ?? ''));
    setDefaulted('workerCron', 'cloudflare.worker-cron');
    setDefaulted('queueName', 'cloudflare.queue-name');
    setDefaulted('deadLetterQueueName', 'cloudflare.dead-letter-queue-name');
    setDefaulted('tunnelName', 'cloudflare.tunnel-name');
    setConfig('cloudflare.tunnelId', controller.getStringFieldValue('cloudflare.tunnel-id', config?.tunnelId ?? ''));
    setConfig('cloudflare.tunnelTokenRef', controller.getStringFieldValue('cloudflare.tunnel-token-ref', config?.tunnelTokenRef ?? ''));
    setConfig('cloudflare.accessAppId', controller.getStringFieldValue('cloudflare.access-app-id', config?.accessAppId ?? ''));
    setConfig('cloudflare.accessServiceTokenId', controller.getStringFieldValue('cloudflare.access-service-token-id', config?.accessServiceTokenId ?? ''));
    setConfig('cloudflare.accessServiceTokenRef', controller.getStringFieldValue('cloudflare.access-service-token-ref', config?.accessServiceTokenRef ?? ''));
    setDefaulted('kvNamespaceName', 'cloudflare.kv-namespace-name');
    setConfig('cloudflare.kvNamespaceId', controller.getStringFieldValue('cloudflare.kv-namespace-id', config?.kvNamespaceId ?? ''));
    setDefaulted('durableObjectNamespaceName', 'cloudflare.do-namespace-name');
    setDefaulted('r2BucketName', 'cloudflare.r2-bucket-name');
    setDefaulted('secretsStoreName', 'cloudflare.secrets-store-name');
    setConfig('cloudflare.secretsStoreId', controller.getStringFieldValue('cloudflare.secrets-store-id', config?.secretsStoreId ?? ''));
    const maxQueueOps = controller.getNumberFieldValue('cloudflare.max-queue-ops-per-day', config?.maxQueueOpsPerDay ?? defaults.maxQueueOpsPerDay, 1);
    if (maxQueueOps !== defaults.maxQueueOpsPerDay || (config?.maxQueueOpsPerDay !== undefined && config.maxQueueOpsPerDay !== defaults.maxQueueOpsPerDay)) {
      setConfig('cloudflare.maxQueueOpsPerDay', maxQueueOps);
    }
    setConfig('batch.mode', batchMode);
    // The Cloudflare queue is switched on by provisioning, and only after the
    // Worker has been seen reaching this daemon; until then jobs stay local.
    if (batchMode === 'off' || !components.queues) setConfig('batch.queueBackend', 'local');
    // Zero Trust Tunnel auto-enables trustProxy on both services so the
    // login-rate-limiter keys on the client address the tunnel forwards rather
    // than the tunnel's own egress address. On its own, that address is read
    // from X-Forwarded-For, which a client reaching the listener directly can
    // set for itself, so it could still choose which address the rate limiter
    // and the audit log recorded.
    //
    // httpListener.trustCloudflare is what closes that: the listener reads
    // CF-Connecting-IP instead, and only when the connecting peer is inside a
    // published Cloudflare range, so a direct client cannot name its own
    // address. This route puts the listener behind the tunnel, which is exactly
    // the deployment the stricter read is for, so the wizard turns it on rather
    // than leaving it to be found in the settings list. It is a no-op without
    // trustProxy, which the same branch writes.
    if (components.zeroTrustTunnel) {
      setConfig('controlPlane.trustProxy', true);
      setConfig('httpListener.trustProxy', true);
      setConfig('httpListener.trustCloudflare', true);
    }
  }

/** The existing daemon this terminal was pointed at, as "Connect to an existing daemon" applied it. */
function readAdoptedDaemonUrl(controller: OnboardingWizardControllerLike): string {
  const adoptHost = controller.getStringFieldValue('network.adopt-daemon-host', '127.0.0.1').trim() || '127.0.0.1';
  return adoptedDaemonUrl(adoptHost, controller.getPortFieldValue('network.adopt-daemon-port', 3421), adoptedDaemonScheme(controller));
}

