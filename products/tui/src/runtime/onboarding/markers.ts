import { createOnboardingMarkerStorage } from '@goodvibes-jev/engine/terminal-shell/onboarding-markers';
export const { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, writeOnboardingCheckMarker } = createOnboardingMarkerStorage('tui');
