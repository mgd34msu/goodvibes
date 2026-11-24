import { createOnboardingMarkerStorage } from '@goodvibes/engine/terminal-shell/onboarding-markers';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
export const { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, writeOnboardingCheckMarker, getOnboardingCompletionMarkerPath, readOnboardingCompletionMarker, writeOnboardingCompletionMarker, readWhoDecidesAsked, writeWhoDecidesAsked } = createOnboardingMarkerStorage(GOODVIBES_AGENT_SURFACE_ROOT);
