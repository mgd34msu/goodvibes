import { createOnboardingStateStorage } from '@goodvibes/engine/terminal-shell/onboarding-state';
export type { OnboardingRuntimeStateRecord } from '@goodvibes/engine/terminal-shell/onboarding-state';
export const { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } = createOnboardingStateStorage('tui');
