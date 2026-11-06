import { createOnboardingStateStorage } from '@goodvibes-jev/engine/terminal-shell/onboarding-state';
export type { OnboardingRuntimeStateRecord } from '@goodvibes-jev/engine/terminal-shell/onboarding-state';
export const { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } = createOnboardingStateStorage('tui');
