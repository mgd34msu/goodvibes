import { createOAuthLocalListener, readConnectedDaemonOrigin, resolveDaemonEnabled } from '@goodvibes/engine/platform/platform/config';
import { getBuiltinSubscriptionProvider, type OAuthProviderConfig } from '@goodvibes/engine/platform/platform/config';
import { summarizeError, openExternalUrl } from '@goodvibes/engine/platform/platform/utils';
import { getProviderIdFromModel } from '@goodvibes/engine/platform/platform/providers';
import { readAuthorizationInput } from '@goodvibes/engine/terminal-shell/settings-subscriptions';
import { collectOnboardingSnapshotForHandler } from './handler-interactions.ts';
import { recordFeatureEnablement } from './onboarding/onboarding-feature-units.ts';
import { handleConnectExistingDaemonForHandler } from './handler-onboarding-daemon-adopt.ts';
import { OnboardingWizardController, type OnboardingWizardAction, type OnboardingWizardApplyFeedback } from './onboarding/onboarding-wizard.ts';
import { handleCloudflareOnboardingActionForHandler, maybeProvisionCloudflareOnFinalApplyForHandler } from './handler-onboarding-cloudflare.ts';
import { applyOnboardingRequest, verifyOnboardingRequest, writeOnboardingCheckMarker } from '../runtime/onboarding/index.ts';
import type { OnboardingApplyRequest, OnboardingVerificationItem } from '../runtime/onboarding/index.ts';
import { beginOnboardingOperation, endOnboardingOperation } from './onboarding-operation.ts';
import {
  dedupeOnboardingVerificationItems,
  formatOnboardingApplyCompletionMessage,
  isLoopbackHostValue,
} from './onboarding/onboarding-verification-helpers.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { captureOnboardingWizardSnapshot, restoreOnboardingWizardSnapshot } from './handler-ui-state.ts';
import type { InputHandlerLike as InputHandler, OnboardingRuntimePosture } from './handler-types.ts';
import {
  formatRuntimeActiveSuccessMessage,
  getRuntimeEndpointStatus,
  isRuntimeEndpointActive,
  isRuntimeEndpointOccupyingConfiguredPort,
  runtimePortDiagnostic,
  type OnboardingExternalServiceState,
  type OnboardingRuntimeEndpoint,
} from './onboarding/onboarding-runtime-status.ts';

function getRuntimeEndpointBinding(
  handler: InputHandler,
  request: OnboardingApplyRequest,
  endpoint: OnboardingRuntimeEndpoint,
): { readonly label: string; readonly host: string; readonly port: number } {
  // A daemon this terminal was pointed at is where it looks, not the local bind.
  const connected = endpoint === 'daemon'
    ? readConnectedDaemonOrigin((key) => handler.getOnboardingConfigValue(request, key))
    : null;
  if (connected) return { label: 'GoodVibes daemon', host: connected.host, port: connected.port };
  const hostKey = endpoint === 'daemon' ? 'controlPlane.host' : 'httpListener.host';
  const portKey = endpoint === 'daemon' ? 'controlPlane.port' : 'httpListener.port';
  const fallbackHost = '127.0.0.1';
  const fallbackPort = endpoint === 'daemon' ? 3421 : 3422;
  const rawHost = handler.getOnboardingConfigValue(request, hostKey);
  const rawPort = handler.getOnboardingConfigValue(request, portKey);
  const parsedPort = typeof rawPort === 'number' ? rawPort : Number(rawPort);
  return {
    label: endpoint === 'daemon' ? 'GoodVibes daemon' : 'HTTP listener',
    host: String(rawHost ?? fallbackHost),
    port: Number.isFinite(parsedPort) ? parsedPort : fallbackPort,
  };
}

function formatRuntimeActiveFailureMessage(
  handler: InputHandler,
  request: OnboardingApplyRequest,
  endpoint: OnboardingRuntimeEndpoint,
  state: OnboardingExternalServiceState | undefined,
): string {
  const binding = getRuntimeEndpointBinding(handler, request, endpoint);
  const portInUse = endpoint === 'daemon' ? state?.daemonPortInUse : state?.httpListenerPortInUse;
  const status = getRuntimeEndpointStatus(state, endpoint);
  // What the person loses and what to do, in plain words; the endpoint's diagnostics stay in /health.
  const where = `${binding.host}:${binding.port}`;
  const taken = portInUse === true || status?.mode === 'blocked' || status?.mode === 'incompatible';
  if (endpoint === 'daemon') {
    const lost = 'so the web UI, your phone and your other devices cannot reach GoodVibes yet. Your settings were saved.';
    return taken
      ? `Another program (or another version of GoodVibes) is using ${where}, ${lost} Stop that program, or choose another port in /setup, "Use it from other devices".`
      : `GoodVibes' background service is not running at ${where}, ${lost} To start it and keep it running, run goodvibes-daemon install-service in a terminal.`;
  }
  const lost = 'so webhooks and events from other tools do not arrive yet. Your settings were saved.';
  return taken
    ? `Another program is using ${where}, ${lost} Stop that program, or choose another port in /setup, "Receive webhooks".`
    : `The webhook receiver is not running at ${where}, ${lost} It starts with GoodVibes' background service.`;
}

function formatRuntimeStoppedFailureMessage(
  handler: InputHandler,
  request: OnboardingApplyRequest,
  endpoint: OnboardingRuntimeEndpoint,
  state?: OnboardingExternalServiceState,
): string {
  const binding = getRuntimeEndpointBinding(handler, request, endpoint);
  const status = getRuntimeEndpointStatus(state, endpoint);
  const disabledSurface = endpoint === 'daemon' ? 'server-backed surfaces' : 'incoming event surfaces';
  const statusDetail = status ? ` ${runtimePortDiagnostic(binding, undefined, status)}` : '';
  return `${binding.label} was disabled for ${disabledSurface}, but ${binding.host}:${binding.port} is still occupied. Settings were saved; another GoodVibes process or external service may still be running on that port.${statusDetail}`;
}

/**
 * Verification item(s) for one runtime endpoint given whether it is expected
 * to be running. Shared by both the "nothing server-backed selected" early
 * path and the full server-backed path so daemon-by-default (the loopback
 * daemon can be `expected` even when nothing else was selected) is handled
 * identically in both places.
 */
function buildEndpointVerificationItems(
  handler: InputHandler,
  request: OnboardingApplyRequest,
  endpoint: OnboardingRuntimeEndpoint,
  expected: boolean,
  state: OnboardingExternalServiceState | undefined,
): OnboardingVerificationItem[] {
    const idPrefix = endpoint === 'daemon' ? 'daemon' : 'http-listener';
    if (expected) {
      const active = isRuntimeEndpointActive(state, endpoint);
      return [{
        id: `runtime:${idPrefix}-active`,
        status: active ? 'pass' : 'fail',
        message: active
          ? formatRuntimeActiveSuccessMessage(endpoint, state)
          : formatRuntimeActiveFailureMessage(handler, request, endpoint, state),
        target: 'service',
      }];
    }
    if (!isRuntimeEndpointOccupyingConfiguredPort(state, endpoint)) return [];
    return [{
      id: `runtime:${idPrefix}-stopped`,
      status: 'fail',
      message: formatRuntimeStoppedFailureMessage(handler, request, endpoint, state),
      target: 'service',
    }];
  }

function showOnboardingApplyFeedbackForHandler(handler: InputHandler, feedback: OnboardingWizardApplyFeedback): void {
    handler.onboardingWizard.setApplyFeedback(feedback);
    handler.requestRender();
  }

export function clearOnboardingPendingModelPickerTargetForHandler(handler: InputHandler): void {
    handler.onboardingWizard.clearPendingModelPickerTarget();
  }

export function clearOnboardingModelPickerCancelStateForHandler(handler: InputHandler): void {
    handler.onboardingModelPickerCancelSnapshot = null;
  }

export function restoreOnboardingModelPickerCancelStateForHandler(handler: InputHandler): void {
    if (!handler.onboardingModelPickerCancelSnapshot) return;
    restoreOnboardingWizardSnapshot(handler.onboardingWizard, handler.onboardingModelPickerCancelSnapshot, {
      active: true,
    });
    handler.onboardingModelPickerCancelSnapshot = null;
  }

export function openModelPickerWithTargetForHandler(
  handler: InputHandler,
    target: ModelPickerTarget,
    source: 'settings' | 'onboarding' = 'settings',
  ): boolean {
    const openModelPicker = handler.commandContext?.openModelPicker;
    if (!openModelPicker) return false;
    if (source === 'onboarding' && handler.onboardingWizard.active) {
      handler.onboardingModelPickerCancelSnapshot = captureOnboardingWizardSnapshot(handler.onboardingWizard);
    } else {
      handler.clearOnboardingModelPickerCancelState();
    }
    handler.clearOnboardingPendingModelPickerTarget();
    handler.modelPicker.target = target;
    openModelPicker();
    return true;
  }

export function openProviderModelPickerWithTargetForHandler(
  handler: InputHandler,
    target: ModelPickerTarget,
    source: 'settings' | 'onboarding' = 'settings',
  ): boolean {
    const openProviderPicker = handler.commandContext?.openProviderPicker;
    if (!openProviderPicker) return false;
    if (source === 'onboarding' && handler.onboardingWizard.active) {
      handler.onboardingModelPickerCancelSnapshot = captureOnboardingWizardSnapshot(handler.onboardingWizard);
    } else {
      handler.clearOnboardingModelPickerCancelState();
    }
    handler.clearOnboardingPendingModelPickerTarget();
    handler.modelPicker.target = target;
    openProviderPicker();
    return true;
  }

export function handleModelPickerCommitForHandler(handler: InputHandler): boolean {
    if (handler.onboardingModelPickerCancelSnapshot && handler.onboardingWizard.active) {
      const selected = handler.modelPicker.mode === 'effort'
        ? handler.modelPicker.pendingModel
        : handler.modelPicker.mode === 'contextCap'
          ? handler.modelPicker.contextCapPendingModel
          : handler.modelPicker.getSelected();
      if (selected) {
        handler.onboardingWizard.applyModelSelection(handler.modelPicker.target, {
          providerId: selected.provider,
          modelId: selected.registryKey ?? selected.id,
          enabled: true,
        });
        if (handler.modelPicker.target === 'main' && handler.modelPicker.mode === 'effort') {
          const effort = handler.modelPicker.effortLevels[handler.modelPicker.selectedIndex];
          if (effort) handler.onboardingWizard.setFieldValue('default-model.reasoning', effort);
        }
      }
      handler.clearOnboardingPendingModelPickerTarget();
      handler.clearOnboardingModelPickerCancelState();
      return true;
    }
    handler.clearOnboardingPendingModelPickerTarget();
    handler.clearOnboardingModelPickerCancelState();
    return false;
  }

export async function handleOnboardingActionForHandler(handler: InputHandler, action: OnboardingWizardAction): Promise<void> {
    if (action === 'retry-hydration') {
      if (handler.onboardingWizard.hydrationError === null) return;
      // The same collection opening setup runs; a newer serial drops any older answer.
      const hydrationSerial = ++handler.onboardingHydrationSerial;
      handler.onboardingWizard.beginRuntimeHydration();
      handler.requestRender();
      await handler.hydrateOnboardingWizardFromRuntime(hydrationSerial);
      return;
    }
    if (action === 'connect-existing-daemon') {
      await handleConnectExistingDaemonForHandler(handler);
      return;
    }
    if (action === 'start-openai-subscription') {
      await handler.handleOpenAiSubscriptionStart();
      return;
    }
    if (action === 'finish-openai-subscription') {
      await handler.handleOpenAiSubscriptionFinish();
      return;
    }
    if (action.startsWith('cloudflare-')) {
      await handleCloudflareOnboardingActionForHandler(handler, action as Extract<OnboardingWizardAction,
        | 'cloudflare-token-requirements'
        | 'cloudflare-create-operational-token'
        | 'cloudflare-discover'
        | 'cloudflare-validate'
        | 'cloudflare-provision'
        | 'cloudflare-verify'
        | 'cloudflare-disable'
      >);
      return;
    }
    if (action !== 'apply') return;
    if (handler.onboardingOperation !== null) {
      beginOnboardingOperation(handler, 'Apply');
      return;
    }
    const blockers = handler.onboardingWizard.getBlockingFieldLabels();
    if (blockers.length > 0) {
      showOnboardingApplyFeedbackForHandler(handler, {
        severity: 'error',
        title: 'Cannot apply yet',
        summary: 'Fix these required or invalid fields, then apply again.',
        messages: blockers,
      });
      return;
    }

    const request = handler.onboardingWizard.buildApplyRequest();
    // A network bind with no local auth cannot be made safe after the fact: refuse it here, before anything is saved.
    const exposure = unsafeNetworkBind(handler, request);
    if (exposure) {
      showOnboardingApplyFeedbackForHandler(handler, {
        severity: 'error',
        title: 'Cannot apply a network bind without local auth',
        summary: 'Nothing was saved.',
        messages: [exposure],
      });
      return;
    }
    handler.onboardingWizard.clearApplyFeedback();
    const deps = {
      config: handler.uiServices.platform.configManager,
      secrets: handler.uiServices.platform.secretsManager,
      auth: handler.uiServices.platform.localUserAuthManager,
      shellPaths: handler.uiServices.environment.shellPaths,
      acknowledgementScope: 'project' as const,
    };
    let appliedErrors: string[] = [];
    // Checks that failed after the settings were saved: reported, never a reason to stop half way.
    let failedChecks: string[] = [];
    let verificationItems: readonly OnboardingVerificationItem[] = [];
    let runtimeWarnings: readonly OnboardingVerificationItem[] = [];
    handler.onboardingOperation = 'Apply';
    try {
      const applied = await applyOnboardingRequest(deps, request);
      if (applied.errors.length > 0) {
        appliedErrors = applied.errors.map((error) => `apply ${error.kind}: ${error.message}`);
      } else {
        const verification = await verifyOnboardingRequest(deps, request);
        verificationItems = verification.items;
        failedChecks = verification.items
          .filter((item) => item.status === 'fail')
          .map((item) => item.message);
      }

      if (appliedErrors.length === 0) {
        try {
          writeOnboardingCheckMarker(handler.uiServices.environment.shellPaths, {
            scope: 'user',
            source: 'wizard',
            mode: request.mode,
          });
        } catch (markerError) {
          handler.commandContext?.print?.(
            `Onboarding check marker could not be written: ${summarizeError(markerError)}`,
          );
        }
        // The settings are saved by now, so a failure in the follow-up restart or posture
        // check is a warning about the runtime, never "could not persist".
        try {
          const activationVerification = await handler.restartOnboardingExternalServicesIfNeeded(request);
          const runtimeItems = [...activationVerification, ...handler.verifyOnboardingRuntimePosture(request)];
          // A network bind left without local auth is a failure, never advice; the rest is advice about the runtime.
          failedChecks = [...failedChecks, ...runtimeItems
            .filter((item) => item.status === 'fail' && item.id === 'runtime:remote-auth-gate')
            .map((item) => item.message)];
          runtimeWarnings = dedupeOnboardingVerificationItems(runtimeItems
            .map((item): OnboardingVerificationItem => item.status === 'fail' && item.id !== 'runtime:remote-auth-gate'
              ? { ...item, status: 'warn' }
              : item));
        } catch (followUpError) {
          runtimeWarnings = [{
            id: 'runtime:post-apply',
            status: 'warn',
            message: `Settings were saved, but restarting services or checking the runtime failed: ${summarizeError(followUpError)}`,
            target: 'runtime',
          }];
        }
        verificationItems = dedupeOnboardingVerificationItems([...verificationItems, ...runtimeWarnings]);
        const cloudflareItems = await maybeProvisionCloudflareOnFinalApplyForHandler(handler);
        verificationItems = dedupeOnboardingVerificationItems([...verificationItems, ...cloudflareItems]);
      }
    } catch (error) {
      showOnboardingApplyFeedbackForHandler(handler, {
        severity: 'error',
        title: 'Apply failed',
        summary: 'The wizard could not persist these settings. No service restart was attempted.',
        messages: [summarizeError(error)],
      });
      return;
    } finally {
      endOnboardingOperation(handler);
      handler.requestRender();
    }

    if (appliedErrors.length > 0) {
      showOnboardingApplyFeedbackForHandler(handler, {
        severity: 'error',
        title: 'Apply did not complete',
        summary: 'The settings were not fully applied. Review the messages below and try again.',
        messages: appliedErrors,
      });
      return;
    }

    handler.syncRuntimeFromOnboardingRequest(request);
    handler.onboardingWizard.markApplied();
    handler.onboardingWizard.close();
    // Setup is finished: it does not come back when a modal stacked over it closes.
    handler.surfaceModals.close(handler.modals.onboarding);
    if (!handler.surfaceModals.active) {
      const returnFocus = handler.modalReturnFocus;
      handler.indicatorFocused = returnFocus === 'indicator';
      handler.modalReturnFocus = 'prompt';
    }
    handler.commandContext?.print?.(formatOnboardingApplyCompletionMessage(verificationItems));
    if (failedChecks.length > 0) {
      handler.commandContext?.print?.([
        `Setup saved your settings, but ${failedChecks.length} check(s) of them failed; the session and services use the new settings:`,
        ...failedChecks.map((check) => `  ${check}`),
        'Fix each one (rerun setup with /setup to see it), then apply again.',
      ].join('\n'));
    }
    handler.requestRender();
  }

/**
 * Why the request would expose a surface on the network with no local auth to
 * guard it, or null. Local auth counts when a user exists already or the request
 * creates one.
 */
function unsafeNetworkBind(handler: InputHandler, request: OnboardingApplyRequest): string | null {
  if (!handler.getOnboardingRuntimePosture(request).remoteExposure) return null;
  if (handler.uiServices.platform.localUserAuthManager.inspect().users.length > 0) return null;
  if (request.operations.some((operation) => operation.kind === 'ensure-auth-user')) return null;
  return 'A control plane, HTTP listener or web surface is set to listen beyond this machine, and no local user exists to sign in. Add a local user in the Auth step, or set the host to loopback, then apply.';
}


export async function refreshOnboardingHydrationForHandler(handler: InputHandler, options: {
    readonly preserveValues?: boolean;
    readonly targetStepId?: string;
  } = {}): Promise<void> {
    const hydrationSerial = ++handler.onboardingHydrationSerial;
    handler.onboardingWizard.beginRuntimeHydration();
    handler.requestRender();
    try {
      const snapshot = await collectOnboardingSnapshotForHandler(handler);
      recordFeatureEnablement(handler.onboardingWizard, handler.uiServices.platform.configManager);
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      handler.onboardingWizard.hydrateRuntimeState({ snapshot }, { resetValues: !(options.preserveValues ?? false) });
      if (options.targetStepId) {
        const targetIndex = handler.onboardingWizard.steps.findIndex((step) => step.id === options.targetStepId);
        if (targetIndex >= 0) handler.onboardingWizard.setStep(targetIndex);
      }
      handler.requestRender();
    } catch (error) {
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      const message = summarizeError(error);
      handler.onboardingWizard.failRuntimeHydration(message);
      handler.requestRender();
    }
  }

/** The built-in OpenAI subscription provider's sign-in parameters; the one definition. */
function openAiSubscriptionOAuth(): OAuthProviderConfig {
  const provider = getBuiltinSubscriptionProvider('openai');
  if (!provider) throw new Error('This build has no built-in OpenAI subscription provider.');
  return provider.oauth;
}

function printSignInCompleted(handler: InputHandler, record: { readonly tokenType: string; readonly expiresAt?: number | undefined }): void {
  handler.commandContext?.print?.([
    'OpenAI subscription sign-in completed from onboarding.',
    `  tokenType: ${record.tokenType}`,
    `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
  ].join('\n'));
}

export async function handleOpenAiSubscriptionStartForHandler(handler: InputHandler): Promise<void> {
    if (!beginOnboardingOperation(handler, 'OpenAI sign-in')) return;
    let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
    try {
      const oauth = openAiSubscriptionOAuth();
      const callback = oauth.localCallback;
      // A listener an earlier start left waiting holds the fixed port and the earlier attempt's state: release it first.
      handler.onboardingOpenAiListener?.close();
      handler.onboardingOpenAiListener = null;
      let bindFailure: string | null = null;
      listener = callback
        ? await createOAuthLocalListener({ expectedState: '', host: callback.host, port: callback.port, path: callback.path }).catch((error: unknown) => {
          bindFailure = `port ${callback.port} could not be opened: ${summarizeError(error)}`;
          return null;
        })
        : null;
      const manager = handler.uiServices.platform.subscriptionManager;
      const started = await manager.beginOAuthLogin('openai', listener ? { ...oauth, redirectUri: listener.redirectUri } : oauth);
      listener?.setExpectedState(started.pending.state);
      const browserOpened = await openExternalUrl(started.authorizationUrl);
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'provider-access' });
      handler.onboardingWizard.setFieldValue('providers.openai-authorization-url', started.authorizationUrl);
      const providerIndex = handler.onboardingWizard.steps.findIndex((step) => step.id === 'provider-access');
      if (providerIndex >= 0) handler.onboardingWizard.setStep(providerIndex);
      handler.requestRender();

      if (listener && callback && browserOpened) {
        handler.onboardingOpenAiListener = listener;
        handler.commandContext?.print?.([
          'OpenAI subscription sign-in started from onboarding.',
          `  callback listener: waiting on ${callback.host}:${callback.port}`,
          '  authorizationUrl: shown in the wizard provider step',
          'You can also paste the callback code or URL into the OpenAI callback field.',
        ].join('\n'));
        void handler.completeOpenAiSubscriptionFromListener(listener, started.pending.verifier);
        listener = null;
        handler.requestRender();
        return;
      }

      const listenerLine = listener ? 'not used (the browser did not open)' : callback ? `unavailable (${bindFailure ?? 'not started'})` : 'unavailable';
      listener?.close();
      listener = null;
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in started from onboarding.',
        `  browser: ${browserOpened ? 'opened' : 'open failed'}`,
        `  callback listener: ${listenerLine}`,
        '  authorizationUrl: shown in the wizard provider step',
        'Paste the callback code or URL into the OpenAI callback field after sign-in.',
      ].join('\n'));
      handler.requestRender();
    } catch (error) {
      listener?.close();
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in could not start.',
        `  ${summarizeError(error)}`,
      ].join('\n'));
      handler.requestRender();
    } finally {
      endOnboardingOperation(handler);
    }
  }

export async function completeOpenAiSubscriptionFromListenerForHandler(
  handler: InputHandler,
    listener: Awaited<ReturnType<typeof createOAuthLocalListener>>,
    verifier: string,
  ): Promise<void> {
    try {
      const callback = await listener.waitForCode();
      const manager = handler.uiServices.platform.subscriptionManager;
      const pending = manager.getPending('openai');
      // A newer start or a manual finish replaced or released this listener: its code is not this attempt's to use.
      if (!pending || pending.verifier !== verifier || listener !== handler.onboardingOpenAiListener) return;
      const record = await manager.completeOAuthLogin('openai', openAiSubscriptionOAuth(), callback.code);
      printSignInCompleted(handler, record);
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'provider-access' });
    } catch (error) {
      // Closed because a newer start or a manual finish took over: nothing to report.
      if (listener !== handler.onboardingOpenAiListener) return;
      handler.commandContext?.print?.([
        'OpenAI subscription listener could not complete automatically.',
        `  listener: ${summarizeError(error)}`,
        'Paste the callback code or URL into the OpenAI callback field to finish in onboarding.',
      ].join('\n'));
      handler.requestRender();
    } finally {
      if (handler.onboardingOpenAiListener === listener) handler.onboardingOpenAiListener = null;
      listener.close();
    }
  }

export async function handleOpenAiSubscriptionFinishForHandler(handler: InputHandler): Promise<void> {
    if (handler.onboardingOperation !== null) {
      beginOnboardingOperation(handler, 'Finish OpenAI sign-in');
      return;
    }
    const manager = handler.uiServices.platform.subscriptionManager;
    const pending = manager.getPending('openai');
    if (!pending) {
      handler.commandContext?.print?.('No pending OpenAI subscription sign-in exists in onboarding. Start the sign-in again.');
      handler.requestRender();
      return;
    }
    // The same reading `/provider finish openai` uses: a provider
    // error in the pasted address is reported, and an address from another
    // login attempt (its state differs) is refused.
    const authorization = readAuthorizationInput(handler.onboardingWizard.getTextFieldValue('providers.openai-callback-code'), pending.state);
    if (!authorization.ok) {
      handler.commandContext?.print?.(`OpenAI subscription sign-in was not finished: ${authorization.reason}`);
      handler.requestRender();
      return;
    }

    handler.onboardingOperation = 'Finish OpenAI sign-in';
    try {
      const record = await manager.completeOAuthLogin('openai', openAiSubscriptionOAuth(), authorization.code);
      // Finished by hand: the callback listener has nothing left to wait for, and its port is freed for a later start.
      const held = handler.onboardingOpenAiListener;
      handler.onboardingOpenAiListener = null;
      held?.close();
      printSignInCompleted(handler, record);
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'provider-access' });
    } catch (error) {
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in could not finish.',
        `  ${summarizeError(error)}`,
      ].join('\n'));
      handler.requestRender();
    } finally {
      endOnboardingOperation(handler);
    }
  }

export function syncRuntimeFromOnboardingRequestForHandler(handler: InputHandler, request: ReturnType<OnboardingWizardController['buildApplyRequest']>): void {
    const runtime = handler.commandContext?.session.runtime;
    if (!runtime) return;

    for (const operation of request.operations) {
      if (operation.kind !== 'set-config') continue;
      if (operation.key === 'provider.model' && typeof operation.value === 'string') {
        runtime.model = operation.value;
        runtime.provider = getProviderIdFromModel(operation.value);
      }
      if (operation.key === 'provider.reasoningEffort' && typeof operation.value === 'string') runtime.reasoningEffort = operation.value;
    }
  }

export function getOnboardingConfigValueForHandler(handler: InputHandler, request: OnboardingApplyRequest, key: string): unknown {
    const config = handler.uiServices.platform.configManager;
    for (let index = request.operations.length - 1; index >= 0; index -= 1) {
      const operation = request.operations[index];
      if (operation?.kind === 'set-config' && operation.key === key) return operation.value;
    }
    return config.get(key as never);
  }

export function getOnboardingRuntimePostureForHandler(handler: InputHandler, request: OnboardingApplyRequest): OnboardingRuntimePosture {
    const getConfigValue = (key: string): unknown => handler.getOnboardingConfigValue(request, key);
    const serviceEnabled = getConfigValue('service.enabled') === true;
    const serviceAutostart = getConfigValue('service.autostart') === true;
    const restartOnFailure = getConfigValue('service.restartOnFailure') === true;
    const daemonReader = { get: (key: string): boolean | string | number | undefined => getConfigValue(key) as boolean | string | number | undefined };
    const daemonEnabled = resolveDaemonEnabled(daemonReader) || getConfigValue('controlPlane.enabled') === true;
    const listenerEnabled = getConfigValue('danger.httpListener') === true;
    const webEnabled = getConfigValue('web.enabled') === true;
    const controlPlaneRemote = getConfigValue('controlPlane.hostMode') === 'network'
      || (getConfigValue('controlPlane.hostMode') === 'custom'
        && !isLoopbackHostValue(String(getConfigValue('controlPlane.host') ?? '')));
    const listenerRemote = getConfigValue('httpListener.hostMode') === 'network'
      || (getConfigValue('httpListener.hostMode') === 'custom'
        && !isLoopbackHostValue(String(getConfigValue('httpListener.host') ?? '')));
    const webRemote = getConfigValue('web.hostMode') === 'network'
      || (getConfigValue('web.hostMode') === 'custom'
        && !isLoopbackHostValue(String(getConfigValue('web.host') ?? '')));
    const remoteExposure = controlPlaneRemote || listenerRemote || webRemote;

    return {
      serviceEnabled,
      serviceAutostart,
      restartOnFailure,
      expectedDaemon: daemonEnabled || webEnabled,
      expectedHttpListener: listenerEnabled,
      // Daemon-by-default: the loopback session daemon can be expected to run
      // even when nothing else was explicitly enabled here, so it does not
      // belong in "did onboarding opt into a network-facing bundle."
      // Service mode is not a server choice: Local TUI Only leaves it as it is.
      serverBacked: getConfigValue('controlPlane.enabled') === true || listenerEnabled || webEnabled,
      remoteExposure,
    };
  }

export async function restartOnboardingExternalServicesIfNeededForHandler(handler: InputHandler, request: OnboardingApplyRequest): Promise<OnboardingVerificationItem[]> {
    const posture = handler.getOnboardingRuntimePosture(request);
    const externalServices = handler.uiServices.platform.externalServices;

    if (!externalServices) {
      return [{
        id: 'runtime:activation-restart',
        status: 'fail',
        message: 'Background service controller is unavailable, so onboarding cannot verify active daemon/listener state.',
        target: 'service',
      }];
    }

    const currentState = externalServices.inspect();
    const hasLiveExternalServices = isRuntimeEndpointOccupyingConfiguredPort(currentState, 'daemon')
      || isRuntimeEndpointOccupyingConfiguredPort(currentState, 'httpListener');
    if (!posture.serverBacked && !hasLiveExternalServices) return [];

    try {
      const state = await externalServices.restart();
      const failures: OnboardingVerificationItem[] = [];
      if (posture.expectedDaemon && !isRuntimeEndpointActive(state, 'daemon')) {
        failures.push({
          id: 'runtime:daemon-active',
          status: 'fail',
          message: formatRuntimeActiveFailureMessage(handler, request, 'daemon', state),
          target: 'service',
        });
      }
      if (!posture.expectedDaemon && isRuntimeEndpointOccupyingConfiguredPort(state, 'daemon')) {
        failures.push({
          id: 'runtime:daemon-stopped',
          status: 'fail',
          message: formatRuntimeStoppedFailureMessage(handler, request, 'daemon', state),
          target: 'service',
        });
      }
      if (posture.expectedHttpListener && !isRuntimeEndpointActive(state, 'httpListener')) {
        failures.push({
          id: 'runtime:http-listener-active',
          status: 'fail',
          message: formatRuntimeActiveFailureMessage(handler, request, 'httpListener', state),
          target: 'service',
        });
      }
      if (!posture.expectedHttpListener && isRuntimeEndpointOccupyingConfiguredPort(state, 'httpListener')) {
        failures.push({
          id: 'runtime:http-listener-stopped',
          status: 'fail',
          message: formatRuntimeStoppedFailureMessage(handler, request, 'httpListener', state),
          target: 'service',
        });
      }
      if (failures.length > 0) return failures;

      return [{
        id: 'runtime:activation-restart',
        status: 'pass',
        message: 'Background services restarted with the applied onboarding settings.',
        target: 'service',
      }];
    } catch (error) {
      return [{
        id: 'runtime:activation-restart',
        status: 'fail',
        message: `Background services could not restart: ${summarizeError(error)}`,
        target: 'service',
      }];
    }
  }

export function verifyOnboardingRuntimePostureForHandler(handler: InputHandler, request: OnboardingApplyRequest): OnboardingVerificationItem[] {
    const posture = handler.getOnboardingRuntimePosture(request);
    const externalServices = handler.uiServices.platform.externalServices;
    const externalState = externalServices?.inspect();
    if (!posture.serverBacked) {
      if (!externalServices) {
        return [{
          id: 'runtime:external-services-controller',
          status: 'fail',
          message: 'Background service controller is unavailable, so onboarding cannot verify daemon/listener shutdown state.',
          target: 'service',
        }];
      }

      // Daemon-by-default: expectedDaemon can be true here (loopback daemon
      // running for cross-surface visibility) even though nothing else was
      // selected, so this is not simply "everything must be stopped."
      const stoppedItems: OnboardingVerificationItem[] = [
        ...buildEndpointVerificationItems(handler, request, 'daemon', posture.expectedDaemon, externalState),
        ...buildEndpointVerificationItems(handler, request, 'httpListener', posture.expectedHttpListener, externalState),
      ];
      if (externalState && stoppedItems.length === 0) {
        stoppedItems.push({
          id: 'runtime:external-services-stopped',
          status: 'pass',
          message: posture.expectedDaemon
            ? 'HTTP listener is stopped for Local TUI Only; the background daemon is running as expected for cross-surface visibility on this machine.'
            : 'Background daemon and HTTP listener are stopped for Local TUI Only.',
          target: 'service',
        });
      }
      return stoppedItems;
    }

    const auth = handler.uiServices.platform.localUserAuthManager.inspect();
    const hasLocalAuth = auth.users.length > 0;
    const items: OnboardingVerificationItem[] = [];

    items.push({
      id: 'runtime:service-mode',
      status: posture.serviceEnabled && posture.serviceAutostart && posture.restartOnFailure ? 'pass' : 'fail',
      message: posture.serviceEnabled && posture.serviceAutostart && posture.restartOnFailure
        ? 'Service mode, autostart, and restart-on-failure are enabled for server-backed onboarding.'
        : 'Server-backed onboarding requires service mode, autostart, and restart-on-failure.',
      target: 'service',
    });
    items.push({
      id: 'runtime:auth-posture',
      status: hasLocalAuth && !auth.bootstrapCredentialPresent ? 'pass' : 'fail',
      message: hasLocalAuth && !auth.bootstrapCredentialPresent
        ? 'Local auth is configured and bootstrap credentials are not present.'
        : hasLocalAuth
          ? 'The first-run sign-in file is still on this computer: remove it with /local-auth once you have signed in, so other devices can only sign in with your account.'
          : 'Other devices can reach GoodVibes, but no account is set up to sign in with yet: create one in /setup, "Who can sign in here".',
      target: 'auth',
    });
    if (posture.remoteExposure) {
      items.push({
        id: 'runtime:remote-auth-gate',
        status: hasLocalAuth ? 'pass' : 'fail',
        message: hasLocalAuth
          ? 'Remote-capable bind settings have local auth available.'
          : 'Remote-capable bind settings cannot be applied without local auth.',
        target: 'auth',
      });
    }

    items.push(
      ...buildEndpointVerificationItems(handler, request, 'daemon', posture.expectedDaemon, externalState),
      ...buildEndpointVerificationItems(handler, request, 'httpListener', posture.expectedHttpListener, externalState),
    );

    return items;
  }
