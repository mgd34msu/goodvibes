export { closeModalByName, getActiveModalName, reopenModalByName, type ActiveModalState, type ModalCloseOps, type ModalOpenOps } from '@goodvibes-jev/engine/terminal-shell/modal-state';
export { handleOverlayToken, handleHistorySearchToken, handleSearchModeToken } from '@goodvibes-jev/engine/terminal-shell/overlay-input-routes';

import type { OnboardingWizardController, OnboardingWizardMode, OnboardingWizardSnapshot } from './onboarding/onboarding-wizard.ts';
export type { OnboardingWizardSnapshot } from './onboarding/onboarding-wizard.ts';

export interface OpenOnboardingWizardOptions {
  readonly mode?: OnboardingWizardMode;
  readonly reset?: boolean;
  readonly preload?: OnboardingWizardSnapshot | ((wizard: OnboardingWizardController) => void);
}

export function captureOnboardingWizardSnapshot(
  wizard: OnboardingWizardController,
): OnboardingWizardSnapshot {
  return wizard.captureSnapshot();
}

export function restoreOnboardingWizardSnapshot(
  wizard: OnboardingWizardController,
  snapshot: OnboardingWizardSnapshot,
  options?: { active?: boolean },
): void {
  wizard.restoreSnapshot(snapshot, options);
}

export function openOnboardingWizardState(
  wizard: OnboardingWizardController,
  options: OpenOnboardingWizardOptions = {},
): void {
  const snapshot = typeof options.preload === 'function' ? null : options.preload;
  const nextMode = options.mode ?? snapshot?.mode ?? wizard.mode;
  const shouldReset = options.reset ?? !wizard.active;

  if (shouldReset) {
    wizard.open(nextMode);
  } else {
    wizard.reopen();
    if (options.mode !== undefined) wizard.setMode(options.mode);
  }

  if (typeof options.preload === 'function') {
    options.preload(wizard);
  } else if (snapshot) {
    restoreOnboardingWizardSnapshot(wizard, snapshot, { active: true });
  }
}

/**
 * Keys shared by the help and shortcuts overlays: ↑↓ and PgUp/PgDn scroll
 * (never past the end the renderer recorded), printable text goes into the
 * always-live search row (the offset returns to the top as the list
 * narrows), Backspace edits it, Esc closes. Returns the new scroll offset.
 */
