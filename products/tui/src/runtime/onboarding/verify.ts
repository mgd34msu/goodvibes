import { createOnboardingVerifier } from '@goodvibes-jev/engine/terminal-shell/onboarding-verification';
import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { readOnboardingRuntimeState } from './state.ts';
import type { OnboardingApplyOperation, OnboardingVerificationDependencies } from './types.ts';
export const verifyOnboardingRequest = createOnboardingVerifier<ConfigKey, OnboardingVerificationDependencies, OnboardingApplyOperation>({
  readState: readOnboardingRuntimeState,
  select: (operation) => operation,
});
