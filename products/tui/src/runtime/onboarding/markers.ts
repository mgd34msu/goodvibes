import { createOnboardingMarkerStorage } from '@goodvibes-jev/engine/terminal-shell/onboarding-markers';
export const { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, readOnboardingCheckMarkers, writeOnboardingCheckMarker } = createOnboardingMarkerStorage('tui');
