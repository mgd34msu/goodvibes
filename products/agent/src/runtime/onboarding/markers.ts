import { createOnboardingMarkerStorage } from '@goodvibes-jev/engine/terminal-shell/onboarding-markers';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
export const { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, readOnboardingCheckMarkers, writeOnboardingCheckMarker, getOnboardingCompletionMarkerPath, readOnboardingCompletionMarker, writeOnboardingCompletionMarker } = createOnboardingMarkerStorage(GOODVIBES_AGENT_SURFACE_ROOT);
