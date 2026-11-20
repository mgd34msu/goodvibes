import {
  CloudflareDaemonRouteError,
  createCloudflareDaemonClient,
  type CloudflareComponentSelection,
  type CloudflareDaemonClient,
  type CloudflareDiscoverResult,
  type CloudflareOperationalTokenResult,
  type CloudflareProvisionRequest,
  type CloudflareProvisionResult,
  type CloudflareTokenRequirementsResult,
  type CloudflareValidateResult,
  type CloudflareVerifyResult,
} from '../runtime/cloudflare-control-plane.ts';
import type { OnboardingVerificationItem } from '../runtime/onboarding/index.ts';
import type { InputHandlerLike as InputHandler } from './handler-types.ts';
import type { OnboardingWizardAction, OnboardingWizardApplyFeedback } from './onboarding/onboarding-wizard.ts';
import {
  buildCloudflareApiTokenRef,
  buildCloudflareProvisionRequest,
  getCloudflareBatchMode,
  getCloudflareComponentSelection,
  getCloudflareSetupSource,
  shouldShowCloudflareStep,
} from './onboarding/onboarding-wizard-cloudflare.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { beginOnboardingOperation, endOnboardingOperation } from './onboarding-operation.ts';

type CloudflareOnboardingAction = Extract<OnboardingWizardAction,
  | 'cloudflare-token-requirements'
  | 'cloudflare-create-operational-token'
  | 'cloudflare-discover'
  | 'cloudflare-validate'
  | 'cloudflare-provision'
  | 'cloudflare-verify'
  | 'cloudflare-disable'
>;

function getCloudflareDaemonClientForHandler(handler: InputHandler): CloudflareDaemonClient {
  return createCloudflareDaemonClient({
    configManager: handler.uiServices.platform.configManager,
    homeDirectory: handler.uiServices.environment.homeDirectory,
  });
}

function normalizeCloudflareActionError(error: unknown): string {
  if (error instanceof CloudflareDaemonRouteError) {
    return `${error.message} (HTTP ${error.status}, ${error.code})`;
  }
  return summarizeError(error);
}

function setCloudflareWizardStatusForHandler(
  handler: InputHandler,
  title: string,
  lines: readonly string[],
  severity: OnboardingWizardApplyFeedback['severity'] = 'info',
): void {
  const message = [title, ...lines].filter((line) => line.length > 0).join('\n');
  handler.onboardingWizard.textState.set('cloudflare.action-status', message);
  handler.onboardingWizard.setApplyFeedback({
    severity,
    title,
    summary: lines[0] ?? title,
    messages: lines.length > 0 ? lines : [title],
  });
  const targetIndex = handler.onboardingWizard.steps.findIndex((step) => step.id === 'cloudflare');
  if (targetIndex >= 0) handler.onboardingWizard.setStep(targetIndex);
  handler.commandContext?.print?.(message);
  handler.requestRender();
}

function formatCloudflareComponents(components: CloudflareComponentSelection): string {
  const enabled = Object.entries(components)
    .filter(([, selected]) => selected === true)
    .map(([component]) => component);
  return enabled.length > 0 ? enabled.join(', ') : 'none';
}

function formatCloudflareRequirements(result: CloudflareTokenRequirementsResult): string[] {
  const permissionLines = result.permissions.length > 0
    ? result.permissions.map((permission) => `  ${permission.scope}: ${permission.permission} (${permission.component}) - ${permission.reason}`)
    : ['  No permissions returned for the selected components.'];
  return [
    `components: ${formatCloudflareComponents(result.components)}`,
    'required permissions:',
    ...permissionLines,
    ...(result.bootstrapToken.instructions.length > 0
      ? ['', 'bootstrap token instructions:', ...result.bootstrapToken.instructions.map((line) => `  ${line}`)]
      : []),
  ];
}

function formatCloudflareValidation(result: CloudflareValidateResult): string[] {
  return [
    `token: ${result.ok ? 'valid' : 'not valid'}`,
    `source: ${result.tokenSource}`,
    result.account
      ? `account: ${result.account.name} (${result.account.id})`
      : 'account: not resolved',
  ];
}

function formatCloudflareDiscovery(result: CloudflareDiscoverResult): string[] {
  return [
    `token source: ${result.tokenSource}`,
    `accounts: ${result.accounts.length}`,
    `zones: ${result.zones.length}`,
    `worker subdomain: ${result.workerSubdomain || 'not detected'}`,
    `queues: ${result.queues?.length ?? 0}`,
    `KV namespaces: ${result.kvNamespaces?.length ?? 0}`,
    `R2 buckets: ${result.r2Buckets?.length ?? 0}`,
    ...(result.selectedAccount ? [`selected account: ${result.selectedAccount.name} (${result.selectedAccount.id})`] : []),
    ...(result.selectedZone ? [`selected zone: ${result.selectedZone.name} (${result.selectedZone.id})`] : []),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ];
}

function formatCloudflareTokenCreate(result: CloudflareOperationalTokenResult): string[] {
  return [
    `token: ${result.tokenName}${result.tokenId ? ` (${result.tokenId})` : ''}${result.reused ? ', the one already made for this selection; nothing new was created' : ''}`,
    `account: ${result.accountId}`,
    `stored ref: ${result.apiTokenRef ?? 'not stored'}`,
    `permissions: ${result.permissions.length}`,
    ...describeReplacedToken(result),
    'Delete or expire the temporary bootstrap token in Cloudflare after confirming the operational token works.',
  ];
}

/** What happened to the token a new one replaced. */
function describeReplacedToken(result: CloudflareOperationalTokenResult): string[] {
  const replaced = result.replaced;
  if (!replaced) return [];
  return [replaced.revoked
    ? `replaced token ${replaced.tokenId}: revoked`
    : `replaced token ${replaced.tokenId}: still live (${replaced.reason ?? 'not revoked'}); delete it in the Cloudflare dashboard (My Profile > API Tokens)`];
}

// ok stays true when steps were skipped or verification failed, so completeness also needs an empty warning list.
function provisionClean(result: CloudflareProvisionResult): boolean {
  return result.ok && !(result.warnings && result.warnings.length > 0);
}

function formatCloudflareProvision(result: CloudflareProvisionResult): string[] {
  return [
    `result: ${provisionClean(result) ? 'ok' : 'needs attention'}`,
    ...(result.worker ? [`worker: ${result.worker.name}${result.worker.baseUrl ? ` at ${result.worker.baseUrl}` : ''}`] : []),
    ...(result.queues ? [`queue: ${result.queues.queueName}; DLQ: ${result.queues.deadLetterQueueName}`] : []),
    ...result.steps.map((step) => `${step.status}: ${step.name}${step.message ? ` - ${step.message}` : ''}`),
    ...(result.verification ? formatCloudflareVerify(result.verification).map((line) => `verify ${line}`) : []),
  ];
}

function formatCloudflareVerify(result: CloudflareVerifyResult): string[] {
  return [
    `worker health: ${result.workerHealth.ok ? 'ok' : 'failed'} (HTTP ${result.workerHealth.status})${result.workerHealth.error ? ` - ${result.workerHealth.error}` : ''}`,
    ...(result.daemonBatchProxy
      ? [`daemon batch proxy: ${result.daemonBatchProxy.ok ? 'ok' : 'failed'} (HTTP ${result.daemonBatchProxy.status})${result.daemonBatchProxy.error ? ` - ${result.daemonBatchProxy.error}` : ''}`]
      : []),
  ];
}

function getCloudflareBootstrapTokenFromWizard(handler: InputHandler): string {
  const wizard = handler.onboardingWizard;
  const setupSource = getCloudflareSetupSource(wizard);
  if (setupSource === 'bootstrap-token') {
    return wizard.getStringFieldValue('cloudflare.bootstrap-token', '');
  }
  if (setupSource === 'bootstrap-env') {
    const envName = wizard.getStringFieldValue('cloudflare.bootstrap-env-name', 'GOODVIBES_CLOUDFLARE_BOOTSTRAP_TOKEN');
    return process.env[envName] ?? '';
  }
  return '';
}

function getCloudflareOperationalTokenFromWizard(handler: InputHandler): string {
  const wizard = handler.onboardingWizard;
  return getCloudflareSetupSource(wizard) === 'operational-token'
    ? wizard.getStringFieldValue('cloudflare.operational-token', '')
    : '';
}

function getCloudflareApiTokenRefFromWizard(handler: InputHandler): string {
  const wizard = handler.onboardingWizard;
  const setupSource = getCloudflareSetupSource(wizard);
  if (setupSource === 'operational-env') {
    return buildCloudflareApiTokenRef(wizard.getStringFieldValue('cloudflare.operational-env-name', 'CLOUDFLARE_API_TOKEN'));
  }
  return wizard.runtimeSnapshot?.config.cloudflare.apiTokenRef ?? '';
}

async function createCloudflareOperationalTokenForHandler(handler: InputHandler): Promise<CloudflareOperationalTokenResult> {
  const wizard = handler.onboardingWizard;
  const bootstrapToken = getCloudflareBootstrapTokenFromWizard(handler);
  if (!bootstrapToken) {
    throw new Error('A bootstrap token is required. Paste it in the wizard or select an environment variable that is set in this TUI process.');
  }
  const accountId = wizard.getStringFieldValue('cloudflare.account-id', wizard.runtimeSnapshot?.config.cloudflare.accountId ?? '');
  const zoneId = wizard.getStringFieldValue('cloudflare.zone-id', wizard.runtimeSnapshot?.config.cloudflare.zoneId ?? '');
  const zoneName = wizard.getStringFieldValue('cloudflare.zone-name', wizard.runtimeSnapshot?.config.cloudflare.zoneName ?? '');
  // The daemon returns the token it already made for the same account, zone and components
  // (also after a restart), and revokes the one a new token replaces.
  return getCloudflareDaemonClientForHandler(handler).createOperationalToken({
    components: getCloudflareComponentSelection(wizard),
    bootstrapToken,
    ...(accountId ? { accountId } : {}),
    ...(zoneId ? { zoneId } : {}),
    ...(zoneName ? { zoneName } : {}),
    storeApiToken: true,
    persistConfig: true,
  });
}

async function buildCloudflareProvisionInputForHandler(handler: InputHandler): Promise<{ readonly input: CloudflareProvisionRequest; readonly token?: CloudflareOperationalTokenResult }> {
  const input = buildCloudflareProvisionRequest(handler.onboardingWizard, { includeTransientSecrets: true });
  const setupSource = getCloudflareSetupSource(handler.onboardingWizard);
  if (setupSource === 'bootstrap-token' || setupSource === 'bootstrap-env') {
    const token = await createCloudflareOperationalTokenForHandler(handler);
    if (token.apiTokenRef) {
      const withoutInlineToken = { ...input };
      delete withoutInlineToken.apiToken;
      return { input: { ...withoutInlineToken, apiTokenRef: token.apiTokenRef }, token };
    }
    return { input, token };
  }
  return { input };
}

function describeTokenInUse(token: CloudflareOperationalTokenResult | undefined): string[] {
  if (!token) return [];
  return [
    `operational token in use: ${token.tokenName}${token.tokenId ? ` (${token.tokenId})` : ''}${token.reused ? ' (reused)' : ' (new)'}`,
    ...describeReplacedToken(token),
  ];
}

function buildCloudflareDiscoveryInputForHandler(handler: InputHandler): Parameters<CloudflareDaemonClient['discover']>[0] {
  const wizard = handler.onboardingWizard;
  const accountId = wizard.getStringFieldValue('cloudflare.account-id', wizard.runtimeSnapshot?.config.cloudflare.accountId ?? '');
  const zoneId = wizard.getStringFieldValue('cloudflare.zone-id', wizard.runtimeSnapshot?.config.cloudflare.zoneId ?? '');
  const zoneName = wizard.getStringFieldValue('cloudflare.zone-name', wizard.runtimeSnapshot?.config.cloudflare.zoneName ?? '');
  const bootstrapToken = getCloudflareBootstrapTokenFromWizard(handler);
  const apiToken = getCloudflareOperationalTokenFromWizard(handler) || bootstrapToken;
  const apiTokenRef = getCloudflareApiTokenRefFromWizard(handler);
  return {
    components: getCloudflareComponentSelection(wizard),
    includeResources: true,
    ...(accountId ? { accountId } : {}),
    ...(zoneId ? { zoneId } : {}),
    ...(zoneName ? { zoneName } : {}),
    ...(apiToken ? { apiToken } : apiTokenRef ? { apiTokenRef } : {}),
  };
}

function buildCloudflareValidateInputForHandler(handler: InputHandler): Parameters<CloudflareDaemonClient['validate']>[0] {
  const wizard = handler.onboardingWizard;
  const accountId = wizard.getStringFieldValue('cloudflare.account-id', wizard.runtimeSnapshot?.config.cloudflare.accountId ?? '');
  const bootstrapToken = getCloudflareBootstrapTokenFromWizard(handler);
  const apiToken = getCloudflareOperationalTokenFromWizard(handler) || bootstrapToken;
  const apiTokenRef = getCloudflareApiTokenRefFromWizard(handler);
  return {
    ...(accountId ? { accountId } : {}),
    ...(apiToken ? { apiToken } : apiTokenRef ? { apiTokenRef } : {}),
  };
}

export async function handleCloudflareOnboardingActionForHandler(
  handler: InputHandler,
  action: CloudflareOnboardingAction,
): Promise<void> {
  if (!beginOnboardingOperation(handler, cloudflareActionName(action))) return;
  handler.onboardingWizard.clearApplyFeedback();
  handler.requestRender();
  try {
    const client = getCloudflareDaemonClientForHandler(handler);
    if (action === 'cloudflare-token-requirements') {
      const result = await client.tokenRequirements({
        components: getCloudflareComponentSelection(handler.onboardingWizard),
        includeBootstrap: true,
      });
      setCloudflareWizardStatusForHandler(handler, 'Cloudflare token requirements', formatCloudflareRequirements(result));
      return;
    }

    if (action === 'cloudflare-create-operational-token') {
      const result = await createCloudflareOperationalTokenForHandler(handler);
      setCloudflareWizardStatusForHandler(handler, result.reused ? 'Cloudflare operational token already made' : 'Cloudflare operational token created', formatCloudflareTokenCreate(result));
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'cloudflare' });
      return;
    }

    if (action === 'cloudflare-discover') {
      const result = await client.discover(buildCloudflareDiscoveryInputForHandler(handler));
      if (result.selectedAccount && !handler.onboardingWizard.getStringFieldValue('cloudflare.account-id', '')) {
        handler.onboardingWizard.setFieldValue('cloudflare.account-id', result.selectedAccount.id);
      } else if (result.accounts.length === 1 && !handler.onboardingWizard.getStringFieldValue('cloudflare.account-id', '')) {
        handler.onboardingWizard.setFieldValue('cloudflare.account-id', result.accounts[0]!.id);
      }
      if (result.selectedZone && !handler.onboardingWizard.getStringFieldValue('cloudflare.zone-id', '')) {
        handler.onboardingWizard.setFieldValue('cloudflare.zone-id', result.selectedZone.id);
        handler.onboardingWizard.setFieldValue('cloudflare.zone-name', result.selectedZone.name);
      } else if (result.zones.length === 1 && !handler.onboardingWizard.getStringFieldValue('cloudflare.zone-id', '')) {
        handler.onboardingWizard.setFieldValue('cloudflare.zone-id', result.zones[0]!.id);
        handler.onboardingWizard.setFieldValue('cloudflare.zone-name', result.zones[0]!.name);
      }
      if (result.workerSubdomain && !handler.onboardingWizard.getStringFieldValue('cloudflare.worker-subdomain', '')) {
        handler.onboardingWizard.setFieldValue('cloudflare.worker-subdomain', result.workerSubdomain);
      }
      setCloudflareWizardStatusForHandler(handler, 'Cloudflare discovery completed', formatCloudflareDiscovery(result));
      return;
    }

    if (action === 'cloudflare-validate') {
      const result = await client.validate(buildCloudflareValidateInputForHandler(handler));
      setCloudflareWizardStatusForHandler(
        handler,
        result.ok ? 'Cloudflare token validated' : 'Cloudflare token validation needs attention',
        formatCloudflareValidation(result),
        result.ok ? 'info' : 'warning',
      );
      return;
    }

    if (action === 'cloudflare-provision') {
      const { input, token } = await buildCloudflareProvisionInputForHandler(handler);
      const result = await client.provision(input);
      setCloudflareWizardStatusForHandler(
        handler,
        provisionClean(result) ? 'Cloudflare provisioning completed' : 'Cloudflare provisioning needs attention',
        [...formatCloudflareProvision(result), ...describeTokenInUse(token)],
        provisionClean(result) ? 'info' : 'warning',
      );
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'cloudflare' });
      return;
    }

    if (action === 'cloudflare-verify') {
      const result = await client.verify({
        workerBaseUrl: handler.onboardingWizard.getStringFieldValue('cloudflare.worker-base-url', handler.onboardingWizard.runtimeSnapshot?.config.cloudflare.workerBaseUrl ?? ''),
        workerClientTokenRef: handler.onboardingWizard.runtimeSnapshot?.config.cloudflare.workerClientTokenRef ?? '',
      });
      setCloudflareWizardStatusForHandler(
        handler,
        result.ok ? 'Cloudflare Worker verified' : 'Cloudflare Worker verification needs attention',
        formatCloudflareVerify(result),
        result.ok ? 'info' : 'warning',
      );
      return;
    }

    if (action === 'cloudflare-disable') {
      const result = await client.disable({
        accountId: handler.onboardingWizard.getStringFieldValue('cloudflare.account-id', handler.onboardingWizard.runtimeSnapshot?.config.cloudflare.accountId ?? ''),
        apiTokenRef: getCloudflareApiTokenRefFromWizard(handler),
        // With a bootstrap token at hand the daemon also revokes the operational token it made.
        ...(getCloudflareBootstrapTokenFromWizard(handler) ? { bootstrapToken: getCloudflareBootstrapTokenFromWizard(handler) } : {}),
        workerName: handler.onboardingWizard.getStringFieldValue('cloudflare.worker-name', handler.onboardingWizard.runtimeSnapshot?.config.cloudflare.workerName ?? 'goodvibes-batch-worker'),
        persistConfig: true,
      });
      setCloudflareWizardStatusForHandler(
        handler,
        result.ok ? 'Cloudflare integration disabled' : 'Cloudflare disable needs attention',
        result.steps.map((step) => `${step.status}: ${step.name}${step.message ? ` - ${step.message}` : ''}`),
        result.ok ? 'info' : 'warning',
      );
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'cloudflare' });
    }
  } catch (error) {
    setCloudflareWizardStatusForHandler(handler, 'Cloudflare action failed', [normalizeCloudflareActionError(error)], 'error');
  } finally {
    endOnboardingOperation(handler);
    handler.requestRender();
  }
}

function cloudflareActionName(action: CloudflareOnboardingAction): string {
  switch (action) {
    case 'cloudflare-token-requirements': return 'Cloudflare token requirements';
    case 'cloudflare-create-operational-token': return 'Cloudflare token creation';
    case 'cloudflare-discover': return 'Cloudflare discovery';
    case 'cloudflare-validate': return 'Cloudflare token check';
    case 'cloudflare-provision': return 'Cloudflare provisioning';
    case 'cloudflare-verify': return 'Cloudflare Worker check';
    case 'cloudflare-disable': return 'Cloudflare disable';
  }
}

export async function maybeProvisionCloudflareOnFinalApplyForHandler(handler: InputHandler): Promise<readonly OnboardingVerificationItem[]> {
  const wizard = handler.onboardingWizard;
  if (!shouldShowCloudflareStep(wizard)) return [];
  const cloudflareEnabled = wizard.getBooleanFieldValue('cloudflare.enabled', wizard.isCapabilitySelected('cloudflare-batch') || wizard.runtimeSnapshot?.config.cloudflare.enabled === true);
  if (!cloudflareEnabled) {
    return [{
      id: 'cloudflare:disabled',
      status: 'pass',
      message: 'Cloudflare integration is disabled; local daemon behavior remains active.',
      target: 'cloudflare',
    }];
  }
  const provisionOnApply = wizard.getStringFieldValue('cloudflare.provision-on-apply', 'no') === 'yes';
  if (!provisionOnApply) {
    return [{
      id: 'cloudflare:configuration-saved',
      status: 'pass',
      message: `Cloudflare settings were saved. Batch mode is ${getCloudflareBatchMode(wizard)}; provisioning was not requested on final apply.`,
      target: 'cloudflare',
    }];
  }

  try {
    const client = getCloudflareDaemonClientForHandler(handler);
    const { input, token } = await buildCloudflareProvisionInputForHandler(handler);
    const result = await client.provision(input);
    handler.onboardingWizard.textState.set('cloudflare.action-status', [
      provisionClean(result) ? 'Cloudflare provisioning completed during final apply.' : 'Cloudflare provisioning needs attention after final apply.',
      ...formatCloudflareProvision(result),
      ...describeTokenInUse(token),
    ].join('\n'));
    return [{
      id: 'cloudflare:provision',
      status: provisionClean(result) ? 'pass' : 'warn',
      message: provisionClean(result)
        ? 'Cloudflare resources were provisioned and verified through the daemon route.'
        : 'Cloudflare provisioning returned warnings or failed verification. Settings were saved; rerun the Cloudflare wizard action after correcting token/resource issues.',
      target: 'cloudflare',
    }];
  } catch (error) {
    return [{
      id: 'cloudflare:provision',
      status: 'warn',
      message: `Cloudflare provisioning did not complete: ${normalizeCloudflareActionError(error)} Settings were saved; retry from the Cloudflare wizard or /cloudflare command.`,
      target: 'cloudflare',
    }];
  }
}
