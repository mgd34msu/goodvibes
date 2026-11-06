import { createOnboardingStateStorage } from '@goodvibes-jev/engine/terminal-shell/onboarding-state';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
export type { OnboardingRuntimeStateRecord } from '@goodvibes-jev/engine/terminal-shell/onboarding-state';
export const { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } = createOnboardingStateStorage(GOODVIBES_AGENT_SURFACE_ROOT);
