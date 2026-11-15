import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { handleOnboardingActionForHandler } from '../../input/handler-onboarding.ts';
import type { InputHandlerLike } from '../../input/handler-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let root: string;
beforeEach(() => { root = makeProjectTempDir('onboarding-apply-followup'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('onboarding apply', () => {
  test('a failure after the settings were saved is not reported as "could not persist"', async () => {
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const feedback: Array<{ title: string; summary: string; messages: readonly string[] }> = [];
    const printed: string[] = [];
    const wizard = {
      getBlockingFieldLabels: () => [] as string[],
      buildApplyRequest: () => ({ mode: 'new', source: 'wizard', operations: [] }),
      clearApplyFeedback() {},
      setApplyFeedback: (value: { title: string; summary: string; messages: readonly string[] }) => { feedback.push(value); },
      steps: [],
      setStep() {},
      isCapabilitySelected: () => false,
      runtimeSnapshot: null,
      getStringFieldValue: (_id: string, fallback: string) => fallback,
      getBooleanFieldValue: (_id: string, fallback: boolean) => fallback,
      markApplied() {},
      close() {},
    };
    const handler = {
      onboardingApplyPending: false,
      onboardingWizard: wizard,
      modalStack: [] as string[],
      modalReturnFocus: 'prompt',
      indicatorFocused: false,
      uiServices: {
        environment: { shellPaths: createShellPathService({ workingDirectory: workspace, homeDirectory: home }), homeDirectory: home },
        platform: {
          configManager: new ConfigManager({ surfaceRoot: 'tui', homeDir: home, workingDir: workspace }),
          secretsManager: {},
          localUserAuthManager: {},
        },
      },
      commandContext: { print: (text: string) => { printed.push(text); } },
      requestRender() {},
      restartOnboardingExternalServicesIfNeeded: async () => [],
      verifyOnboardingRuntimePosture: () => { throw new Error('auth inspection unavailable'); },
      syncRuntimeFromOnboardingRequest() {},
    } as unknown as InputHandlerLike;

    await handleOnboardingActionForHandler(handler, 'apply');

    expect(feedback.map((entry) => entry.summary).join('\n')).not.toContain('could not persist');
    const output = printed.join('\n');
    expect(output).toContain('auth inspection unavailable');
  });
});
