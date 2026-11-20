import { createOnboardingMarkerStorage } from '@goodvibes/engine/terminal-shell/onboarding-markers';
export const { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, writeOnboardingCheckMarker } = createOnboardingMarkerStorage('tui');
