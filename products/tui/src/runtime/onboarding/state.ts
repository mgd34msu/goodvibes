import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { createOnboardingStateStorage } from '@goodvibes/engine/terminal-shell/onboarding-state';
export type { OnboardingRuntimeStateRecord } from '@goodvibes/engine/terminal-shell/onboarding-state';
export const { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } = createOnboardingStateStorage(GOODVIBES_TUI_SURFACE_ROOT);
