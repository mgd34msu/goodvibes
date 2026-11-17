import { createHandlerContentBindings } from '@goodvibes-jev/engine/terminal-shell/handler-content-bindings';
import { buildProviderAccountSnapshot } from '@/runtime/index.ts';
import { enrichProviderAccountsSnapshot } from '../runtime/onboarding/provider-key-capture.ts';
import type { OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import { collectOnboardingSnapshot } from '../runtime/onboarding/index.ts';
import {
  expandPrompt,
  handleBlockCopy,
  handleBlockSave,
  handleBlockToggle,
  handleBookmark,
  handleCopy,
  handleDiffApply,
} from './handler-content-actions.ts';
import { handleEscape } from './handler-modal-stack.ts';
import { recordFeatureEnablement } from './onboarding/onboarding-feature-units.ts';
import { openOnboardingWizardState, type OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import type { InputHandlerLike as InputHandler } from './handler-types.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

/** The one place the wizard's runtime snapshot is collected, for the open-time and refresh paths alike. */
export function collectOnboardingSnapshotForHandler(handler: InputHandler): ReturnType<typeof collectOnboardingSnapshot> {
  return collectOnboardingSnapshot({
    config: handler.uiServices.platform.configManager,
    shellPaths: handler.uiServices.environment.shellPaths,
    acknowledgementScope: 'project',
    subscriptions: handler.uiServices.platform.subscriptionManager,
    secrets: handler.uiServices.platform.secretsManager,
    auth: handler.uiServices.platform.localUserAuthManager,
    services: handler.uiServices.platform.serviceRegistry,
    surfaces: {
      list: () => handler.uiServices.platform.surfaceRegistry.syncConfiguredSurfaces(),
    },
    providerAccounts: {
      loadSnapshot: async () =>
        enrichProviderAccountsSnapshot(
          await buildProviderAccountSnapshot({
            providerRegistry: handler.uiServices.providers.providerRegistry,
            serviceRegistry: handler.uiServices.platform.serviceRegistry,
            subscriptionManager: handler.uiServices.platform.subscriptionManager,
            secretsManager: handler.uiServices.platform.secretsManager,
          }),
          handler.uiServices.providers.providerRegistry,
        ),
    },
  });
}

export function openOnboardingWizardForHandler(
  handler: InputHandler,
  modeOrOptions: OnboardingWizardMode | OpenOnboardingWizardOptions = 'new',
): void {
  const options = typeof modeOrOptions === 'string' ? { mode: modeOrOptions } : modeOrOptions;
  handler.clearOnboardingModelPickerCancelState();
  openOnboardingWizardState(handler.onboardingWizard, options);
  const hydrationSerial = ++handler.onboardingHydrationSerial;
  if (options.preload === undefined) {
    handler.onboardingWizard.beginRuntimeHydration();
    void handler.hydrateOnboardingWizardFromRuntime(hydrationSerial);
  }
  handler.requestRender();
}

export async function hydrateOnboardingWizardFromRuntimeForHandler(handler: InputHandler, hydrationSerial: number): Promise<void> {
  try {
    const snapshot = await collectOnboardingSnapshotForHandler(handler);
    recordFeatureEnablement(handler.onboardingWizard, handler.uiServices.platform.configManager);
    if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
    handler.onboardingWizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    handler.requestRender();
  } catch (error) {
    if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
    const message = summarizeError(error);
    handler.onboardingWizard.failRuntimeHydration(message);
    handler.commandContext?.print?.(`Onboarding runtime snapshot failed: ${message}`);
    handler.requestRender();
  }
}

/**
 * executeBlockAction - Execute a block action ID on the block the
 * BlockActionsMenu was opened for. Called when the user selects an action
 * from the menu.
 */
export function executeBlockActionForHandler(handler: InputHandler, actionId: string): void {
  switch (actionId) {
    case 'copy':
      handler.handleBlockCopy();
      break;
    case 'bookmark':
      handler.handleBookmark();
      break;
    case 'toggle':
      handler.handleBlockToggle();
      break;
    case 'apply':
      handler.handleDiffApply();
      break;
  }
}

/** Apply the diff under the anchor line (block actions, "Apply diff"). */
export function handleDiffApplyForHandler(handler: InputHandler): void {
  handleDiffApply(
    handler.conversationManager,
    () => handler.getBlockAnchorLine(),
    handler.commandContext,
    handler.requestRender,
    () => `diff-apply-${Date.now()}`,
    'write',
  );
}

export function handleEscapeForHandler(handler: InputHandler): void {
  handleEscape(handler, handler.commandContext?.cancelGeneration);
}

export const {
  handlePasteForHandler,
  registerPasteForHandler,
  expandPromptForHandler,
  getImageAttachmentsForHandler,
  cleanupMarkerRegistryForHandler,
  findMarkerAtPosForHandler,
  handleCopyForHandler,
  handleBlockCopyForHandler,
  handleBookmarkForHandler,
  handleBlockSaveForHandler,
  handleBlockToggleForHandler,
  handleCtrlCForHandler,
} = createHandlerContentBindings<InputHandler>({
  anchor: (host) => () => host.getBlockAnchorLine(),
  emptyClipboard: () => '[Paste: clipboard does not contain supported text or image data]',
  ownCtrlCTimeout: true,
  expandPrompt,
  actions: { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle },
});
