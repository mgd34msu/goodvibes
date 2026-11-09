import { captureOnboardingReadFacts } from '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';
import { collectTerminalOnboardingSnapshot } from '@goodvibes-jev/engine/terminal-shell/onboarding-snapshot-collector';
import {
  createOnboardingSnapshotReadHelpers,
  captureOnboardingConfigSnapshot,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-snapshot-reads';
import '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';
import '@goodvibes-jev/engine/terminal-shell/onboarding-read-facts';

import { getProviderIdFromModel } from '@goodvibes-jev/engine/platform/platform/providers';
import { readOnboardingRuntimeState } from './state.ts';
import type {
  OnboardingConfigSnapshot,
  OnboardingLegacyDaemonSnapshot,
  OnboardingSnapshotCollectionIssueArea,
  OnboardingSnapshotDependencies,
  OnboardingSnapshotState,
} from './types.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

function buildConfigSnapshot(config: OnboardingSnapshotDependencies['config']): OnboardingConfigSnapshot {
  return captureOnboardingConfigSnapshot(config, [
    'display',
    'provider',
    'behavior',
    'storage',
    'permissions',
    'helper',
    'tools',
    'danger',
    'controlPlane',
    'httpListener',
    'web',
    'network',
    'surfaces',
    'service',
    'batch',
    'cloudflare',
  ]);
}

function buildFallbackLegacyDaemonSnapshot(): OnboardingLegacyDaemonSnapshot {
  return { present: false, active: false, path: '' };
}

export async function collectOnboardingSnapshot(deps: OnboardingSnapshotDependencies): Promise<OnboardingSnapshotState> {
  const facts = captureOnboardingReadFacts(
    deps,
    () => buildConfigSnapshot(deps.config),
    getProviderIdFromModel,
    readOnboardingRuntimeState,
  );
  const { config } = facts;
  const { state, extra } = await collectTerminalOnboardingSnapshot(
    deps,
    facts,
    { loadOptionalSnapshot, buildServicesSnapshot },
    {
      drainOnFailure: false,
      readExtra: () =>
        loadOptionalSnapshot(
          'legacy-daemon',
          deps.legacyDaemon ? () => Promise.resolve(deps.legacyDaemon!.detect()) : undefined,
          buildFallbackLegacyDaemonSnapshot(),
        ),
    },
  );
  if (extra.issue) state.collectionIssues.push(extra.issue);
  return {
    ...state,
    bindSettings: {
      daemonEnabled: false,
      httpListenerEnabled: Boolean(config.danger.httpListener),
      controlPlane: config.controlPlane,
      httpListener: config.httpListener,
      web: config.web,
    },
    legacyDaemon: extra.value,
  };
}

const { buildServicesSnapshot, loadOptionalSnapshot } = createOnboardingSnapshotReadHelpers<OnboardingSnapshotCollectionIssueArea>({
  serviceArea: 'services',
  drainOnFailure: false,
  error: summarizeError,
});
