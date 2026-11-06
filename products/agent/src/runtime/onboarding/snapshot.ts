import { captureOnboardingReadFacts } from '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';
import { collectTerminalOnboardingSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-snapshot-collector';
import {
  createOnboardingSnapshotReadHelpers,
  captureOnboardingConfigSnapshot,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-snapshot-reads';
import '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';
import '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';

import { getProviderIdFromModel } from '../../config/provider-model.ts';
import { summarizeAgentBehaviorDiscovery } from '../../agent/behavior-discovery-summary.ts';
import { readOnboardingRuntimeState } from './state.ts';
import { captureNativeReadRestrictions } from '../read-restrictions.ts';
import type {
  OnboardingConfigSnapshot,
  OnboardingSnapshotCollectionIssueArea,
  OnboardingSnapshotDependencies,
  OnboardingSnapshotState,
} from './types.ts';

export interface OnboardingSnapshotReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

function snapshotReadGuard(options: OnboardingSnapshotReadOptions): () => void {
  return captureNativeReadRestrictions(options);
}

function buildConfigSnapshot(config: OnboardingSnapshotDependencies['config']): OnboardingConfigSnapshot {
  return captureOnboardingConfigSnapshot(config, [
    'display',
    'provider',
    'behavior',
    'storage',
    'permissions',
    'helper',
    'tools',
    'surfaces',
  ]);
}

export async function collectOnboardingSnapshot(
  deps: OnboardingSnapshotDependencies,
  options: OnboardingSnapshotReadOptions = {},
): Promise<OnboardingSnapshotState> {
  const assertCurrent = snapshotReadGuard(options);
  assertCurrent();
  const facts = captureOnboardingReadFacts(
    deps,
    () => buildConfigSnapshot(deps.config),
    getProviderIdFromModel,
    readOnboardingRuntimeState,
  );
  const { state } = await collectTerminalOnboardingSnapshot(
    deps,
    facts,
    { loadOptionalSnapshot, buildServicesSnapshot },
    { assertCurrent, drainOnFailure: true, readExtra: async () => undefined },
  );
  return { ...state, localBehaviorDiscovery: summarizeAgentBehaviorDiscovery(deps.shellPaths) };
}

const { buildServicesSnapshot, loadOptionalSnapshot } = createOnboardingSnapshotReadHelpers<OnboardingSnapshotCollectionIssueArea>({
  serviceArea: 'host',
  drainOnFailure: true,
  error: (error) => (error instanceof Error ? error.message : String(error)),
});
