import { afterEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { peekChannelStatusContent, prepareChannelStatusContent } from '../sdk/src/platform/channels/status-reading.js';
import { readTouchesSecrets, forgetReadSecrets } from '../sdk/src/platform/permissions/credential-read-defaults.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; forgetReadSecrets(); });
const under = <T>(policy: DecisionModelPolicy, operation: () => T) => withDecisionModelPolicy(() => policy, operation);
function install(port: JudgmentPort) { previous = installJudgmentPort(port); installed = true; }

test.each(['Classic - Off', 'Preferred'] as const)('%s retains original progress notices without a semantic filter', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); }); install(fake.port);
  await under(policy, async () => {
    await prepareChannelStatusContent(['Reading src/config.ts.', 'Thinking…']);
    expect(decisionModelPolicyState().operation).toBe('classic');
    expect(peekChannelStatusContent('Reading src/config.ts.')).toBeUndefined();
    const attempted = fake.requests.length;
    expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
    await prepareChannelStatusContent(['The build completed.']);
    expect(fake.requests).toHaveLength(attempted);
  });
});

test('Classic cannot hide a progress notice using an earlier cached semantic no', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); install(fake.port);
  await under('Default - On', async () => {
    await prepareChannelStatusContent(['Thinking…']);
    expect(peekChannelStatusContent('Thinking…')).toBe(false);
  });
  const attempted = fake.requests.length;
  await under('Classic - Off', async () => {
    expect(peekChannelStatusContent('Thinking…')).toBeUndefined();
    await prepareChannelStatusContent(['Thinking…']); expect(fake.requests).toHaveLength(attempted);
  });
});

test('Classic read escalation does not reuse a cached semantic absence of secrets', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); install(fake.port);
  await under('Default - On', async () => {
    expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(false);
  });
  const attempted = fake.requests.length;
  await under('Classic - Off', async () => {
    expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(true);
    expect(fake.requests).toHaveLength(attempted);
    const controller = new AbortController(); controller.abort();
    await expect(readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic', controller.signal)).rejects.toThrow();
  });
});

test('Preferred read outage escalates to the owner and retains Classic for subsequent reads', async () => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); }); install(fake.port);
  await under('Preferred', async () => {
    expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(true);
    expect(decisionModelPolicyState().operation).toBe('classic');
    const attempted = fake.requests.length;
    expect(await readTouchesSecrets('read', { file: 'src/other.ts' }, '/synthetic')).toBe(true);
    expect(fake.requests).toHaveLength(attempted);
  });
});
