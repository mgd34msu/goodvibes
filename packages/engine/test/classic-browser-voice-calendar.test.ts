import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { BrowserControlIdentityWork } from '../platform/src/platform/browser/browser-control-identity.js';
import { readBrowserLaunchCause } from '../platform/src/platform/browser/launch-reading.js';
import { missingLibrary, networkBlocked, programNotInstalled } from '../platform/src/platform/browser/browser-failure-reading.js';
import { ownRecorderFailure, readRecorderFailure } from '../platform/src/platform/voice/capture/recorder-failure-reading.js';
import { ownLocalEngineFailureLifetime, readLocalEngineFailure, structuredLocalEngineFailure } from '../platform/src/platform/voice/providers/local-failure-reading.js';
import { readMissingPermission } from '../platform/src/platform/calendar/batteries/missing-permission.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  return fake.requests;
}

test('Classic browser work retains cancellation and refuses paraphrase-based control identity', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const controller = new AbortController();
    const work = new BrowserControlIdentityWork({ signal: controller.signal });
    expect(await work.wait(async () => 'native result')).toBe('native result');
    expect(await work.sameControl({ recorded: { name: 'Send message' }, current: { name: 'Submit message' } })).toBe(false);
    expect(await work.credentialPage({}, async () => {})).toBe('unresolved');
    controller.abort(); expect(work.assertCurrent).toThrow();
    await expect(work.action(async () => 'late effect')).rejects.toThrow();
  });
  expect(requests).toHaveLength(0);
});

test.each(['Classic - Off', 'Preferred'] as const)('%s browser launch diagnostics do not infer a repair from prose', async policy => {
  const requests = outage();
  await withDecisionModelPolicy(() => policy, async () => {
    expect(await readBrowserLaunchCause('An unclassified launch failure.')).toBe('unknown');
    const attempted = requests.length;
    expect(attempted).toBe(policy === 'Preferred' ? 1 : 0);
    const outcome = { code: 1, stdout: '', stderr: 'A library might be missing, but the cause is unknown.', timedOut: false, spawnError: null };
    expect(await missingLibrary('browser', outcome, {})).toBeNull();
    expect(await networkBlocked('browser-installer', outcome, {})).toBe(false);
    expect(await programNotInstalled('browser', { ...outcome, spawnError: 'Executable missing', spawnCode: 'ENOENT' })).toBe(true);
    expect(requests).toHaveLength(attempted);
  });
});

test('Classic voice diagnostics retain process facts without claiming an inferred microphone or model cause', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const controller = new AbortController();
    const owner = ownRecorderFailure({ device: 'synthetic-device' }, controller.signal);
    expect(await readRecorderFailure({ stderr: 'An unclassified recorder failure.' }, owner)).toBe('unavailable');
    const lifetime = ownLocalEngineFailureLifetime({ engine: 'synthetic-engine', binary: '/synthetic/engine', modelPath: '/synthetic/model' }, controller.signal, () => controller.signal.throwIfAborted());
    expect(await readLocalEngineFailure(new Error('Unclassified engine failure.'), 'synthetic-engine', 'TTS', lifetime)).toBeUndefined();
    expect(structuredLocalEngineFailure({ signal: 'SIGSEGV' })).toEqual({ kind: 'fatal-crash', signal: 'SIGSEGV' });
    controller.abort();
    await expect(readLocalEngineFailure(new Error('Late failure.'), 'synthetic-engine', 'TTS', lifetime)).rejects.toThrow();
  });
  expect(requests).toHaveLength(0);
});

test('Classic calendar permission guidance uses only the declared authentication challenge', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await readMissingPermission('google', 'Provider refused this request.', '')).toBeUndefined();
    expect(await readMissingPermission('google', 'Provider refused this request.', 'Bearer error="insufficient_scope", scope="calendar.read"')).toBe('calendar.read');
  });
  expect(requests).toHaveLength(0);
});
