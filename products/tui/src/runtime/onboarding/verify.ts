import { createOnboardingVerifier } from '@goodvibes/engine/terminal-shell/onboarding-verification';
import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { readOnboardingRuntimeState } from './state.ts';
import type { OnboardingApplyOperation, OnboardingVerificationDependencies } from './types.ts';
export const verifyOnboardingRequest = createOnboardingVerifier<ConfigKey, OnboardingVerificationDependencies, OnboardingApplyOperation>({
  readState: readOnboardingRuntimeState,
  select: (operation) => operation,
});
