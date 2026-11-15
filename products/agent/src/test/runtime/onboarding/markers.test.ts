import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import {
  getOnboardingCheckMarkerPath,
  getOnboardingCompletionMarkerPath,
  readOnboardingCheckMarker,
  readOnboardingCompletionMarker,
  writeOnboardingCheckMarker,
  writeOnboardingCompletionMarker,
} from '../../../runtime/onboarding/index.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

function createShellPaths() {
  const root = makeProjectTempDir(`gv-onboarding-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });
}

describe('onboarding check marker helpers', () => {
  test('stores completion separately from check markers', () => {
    const shellPaths = createShellPaths();

    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      checkedAt: 500,
      source: 'command',
    });
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      checkedAt: 600,
      source: 'wizard',
      mode: 'new',
    });

    const checkPath = getOnboardingCheckMarkerPath(shellPaths, 'user');
    const completionPath = getOnboardingCompletionMarkerPath(shellPaths, 'user');
    const marker = readOnboardingCheckMarker(shellPaths);
    const completion = readOnboardingCompletionMarker(shellPaths, 'user');

    expect(completionPath).not.toBe(checkPath);
    expect(marker.payload?.checkedAt).toBe(500);
    expect(completion.payload?.checkedAt).toBe(600);
    expect(completion.payload?.source).toBe('wizard');
  });
});
