import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { createOnboardingMarkerStorage } from '@goodvibes/engine/terminal-shell/onboarding-markers';
export const { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, writeOnboardingCheckMarker } = createOnboardingMarkerStorage(GOODVIBES_TUI_SURFACE_ROOT);
