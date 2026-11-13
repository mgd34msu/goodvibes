/**
 * Wake runtime lifecycle: what is left behind after a failed start and after stop.
 *
 * A refused start left its refusal chip showing after wake was switched off, and
 * a start that rejected left the listener set so every later refresh returned
 * early, with the rejection escaping from `void runtime.refresh()`.
 */
import { describe, expect, test } from 'bun:test';
import type { AudioCaptureHandlers, AudioCaptureRequest } from '@goodvibes-jev/engine/platform/platform/voice/capture';

import { startWakeRuntime, wireWakeRuntime, type WakeRuntimeDeps } from '../../audio/wake-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type Device = { id: string; label: string; isMonitor: boolean; isDefault?: boolean };
const MIC: Device = { id: 'alsa_input.analog-stereo', label: 'alsa_input.analog-stereo', isMonitor: false, isDefault: true };
const MONITOR: Device = { id: 'alsa_output.hdmi.monitor', label: 'alsa_output.hdmi.monitor', isMonitor: true };

function harness() {
  const notices: string[] = [];
  const config: Record<string, unknown> = {
    'voice.wake.enabled': true,
    'voice.wake.surfaces.agent': true,
    'voice.wake.inputDevice': '',
    'voice.wake.captureCommand': 'auto',
    'voice.wake.indicator': 'statusline',
  };
  const listeners: Array<() => void> = [];
  const state: { enumerate: () => Promise<readonly Device[]>; renderFailures: number } = { enumerate: async () => [MIC], renderFailures: 0 };
  const managedRoot = makeProjectTempDir('gv-wake-lifecycle');
  const deps: WakeRuntimeDeps = {
    readConfig: (key) => config[key],
    subscribeConfig: (_key, listener) => { listeners.push(listener); return () => {}; },
    openCapture: async (_request: AudioCaptureRequest, _handlers: AudioCaptureHandlers) => ({ label: 'pw-record (auto)', deviceSelectable: true, stop: async () => {} }),
    managedRoot,
    assetDirectory: `${managedRoot}/assets`,
    resolveTranscriber: () => ({ available: false as const, reason: 'not needed' }),
    playActivationSound: () => {},
    submitTurn: () => {},
    writeDraft: () => {},
    notify: (message) => { notices.push(message); },
    // The listener reports its state through render, so a render that throws once is a start that rejects.
    render: () => { if (state.renderFailures > 0) { state.renderFailures -= 1; throw new Error('render exploded'); } },
    sessionId: 'test-session',
    warn: () => {},
    enumerateInputDevices: () => state.enumerate(),
    provisionStatus: () => ({ ready: true, reason: null, vadReady: false }),
    loadSession: async () => ({ run: async () => ({}), release: async () => {} }) as never,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  return { runtime: wireWakeRuntime(deps), deps, config, notices, state, listeners };
}

describe('wake runtime after a failed start', () => {
  test('turning wake off clears the refusal chip', async () => {
    const wake = harness();
    wake.state.enumerate = async () => [MONITOR];
    await wake.runtime.refresh();
    expect(wake.runtime.status()?.kind).toBe('wake-no-microphone');

    wake.config['voice.wake.enabled'] = false;
    await wake.runtime.refresh();
    expect(wake.runtime.status()).toBeNull();
  });

  test('a start that rejects is reported, leaves nothing set, and the next refresh starts again', async () => {
    const wake = harness();
    wake.state.renderFailures = 1;
    await wake.runtime.refresh();
    expect(wake.notices.join('\n')).toContain('render exploded');
    expect(wake.runtime.status()).toBeNull();

    await wake.runtime.refresh();
    expect(wake.runtime.status()).not.toBeNull();
    await wake.runtime.stop();
  });

  test('the config subscription never leaves a refresh rejection unhandled', async () => {
    const wake = harness();
    wake.state.renderFailures = 1;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const unsubs = startWakeRuntime(wake.runtime, { subscribeConfig: wake.deps.subscribeConfig });
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const unsub of unsubs) unsub();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(wake.notices.join('\n')).toContain('render exploded');
  });
});
