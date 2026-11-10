import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedNativeProcessClose, drainNativeProcessGroup } from '../../../scripts/native-execution-process.mjs';
import { nativeStartupPhases } from '../../../scripts/native-startup-liveness.mjs';
import type { NativeStartupPhase } from '../../runtime/startup-observation.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const phases: readonly NativeStartupPhase[] = [
  'runtime-base', 'base-project-context', 'base-credentials', 'base-providers', 'base-knowledge',
  'base-native-intake-storage', 'base-native-intake-ready', 'runtime-base-failed',
  'handler-surfaces', 'contract-recovery', 'provider-preload', 'listener-construction',
  'secondary-listener-construction', 'cluster-startup', 'device-recovery', 'device-grant-sweep',
  'device-capture-sweep', 'device-disclosure-read', 'device-disclosure-persist', 'listener-startup',
  'secondary-listener-startup', 'boot-tasks', 'foreground-ready',
];

test.skipIf(process.platform === 'win32').each([false, true])('fixed native startup phases retain the last stage and stay opt-in (enabled=%s)', async enabled => {
  expect(nativeStartupPhases).toEqual(phases);
  const modulePath = fileURLToPath(new URL('../../runtime/startup-observation.ts', import.meta.url));
  const script = `import {observeNativeStartupPhase} from ${JSON.stringify(modulePath)};
for (const phase of ${JSON.stringify(phases)}) { observeNativeStartupPhase(phase); observeNativeStartupPhase(phase); }`;
  const child = spawn(process.execPath, ['--no-env-file', '--no-autoload-bunfig', '--eval', script], {
    cwd: makeOwnedTempDir('native-startup-observation'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GOODVIBES_NATIVE_STARTUP_OBSERVATION: enabled ? '1' : '0' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    expect(await boundedNativeProcessClose(closed, 5_000, 'Startup observation child did not close')).toEqual({ code: 0, signal: null });
    expect(stdout).toBe('');
    expect(stderr).toBe(enabled ? phases.map(phase => `[goodvibes-daemon:native-startup-phase] ${phase}\n`).join('') : '');
  } finally {
    try { await drainNativeProcessGroup(child, closed); }
    finally { child.stdout.destroy(); child.stderr.destroy(); }
  }
});
