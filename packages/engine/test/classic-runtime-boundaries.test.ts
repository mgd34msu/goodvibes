import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { redactConfigValue, redactObjectByPath } from '../sdk/src/platform/tools/goodvibes-runtime/credential-redaction.js';
import { readRetryWaitMs } from '../sdk/src/platform/types/batteries/retry-wait.js';
import { ProviderError, readRetryWait } from '../sdk/src/platform/types/errors.js';
import { readToolCall, readCatastrophic } from '../sdk/src/platform/gate/reading.js';
import { readRequest } from '../sdk/src/platform/routing/request-reading.js';
import { planTaskRoute } from '../sdk/src/platform/routing/task-routes/planner.js';
import { readAutonomyIntake } from '../sdk/src/platform/routing/task-routes/autonomy-intake.js';
import { ProfileDistinctiveReader, readResidualProjection } from '../sdk/src/platform/utils/redaction-reading.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function install(port: JudgmentPort) { previous = installJudgmentPort(port); installed = true; }

test('Classic config reads keep public schema values, mask unknown roles and preserve explicit provider retry guidance', async () => {
  let metadata = 0, requests = 0;
  const forbidden: JudgmentPort = { get model(): never { metadata++; throw new Error('Unexpected model access'); },
    async ask() { requests++; throw new Error('Unexpected decision request'); } };
  install(forbidden);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await redactConfigValue('provider.model', 'fixture-general-model')).toBe('fixture-general-model');
    expect(await redactConfigValue('unclassified.value', 'not-a-declared-public-setting')).toMatchObject({ redacted: true });
    expect(await redactObjectByPath('provider', { model: 'fixture-general-model' })).toEqual({ model: 'fixture-general-model' });
    expect(await readRetryWaitMs({ message: 'Please retry in 5 minutes', status: 429 }, 'test.classic.retry')).toBeUndefined();
    expect(await readRetryWait(new ProviderError('Retry in 5 minutes', { statusCode: 429, retryAfterMs: 7300 }))).toBe(7300);
    expect(await readResidualProjection([], {})).toBeUndefined();
    expect(new ProfileDistinctiveReader().read({ field: 'profile.role', sourceKind: 'field' }, { assertCurrent() {} })).toBeUndefined();
    for (const operation of [
      () => readToolCall({ toolName: 'exec', args: { command: 'pwd' }, port: forbidden }),
      () => readCatastrophic('pwd'),
      () => readRequest({ purpose: 'conversation', brief: 'Find the file' }),
      () => planTaskRoute({ query: 'Find the file' }),
      () => readAutonomyIntake('Find the file'),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'decision-models-disabled' });
  });
  expect({ metadata, requests }).toEqual({ metadata: 0, requests: 0 });
});

test('Preferred retry prose exhaustion cannot invent a delay or restart semantic calls in the same operation', async () => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic chain exhaustion'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    expect(await readRetryWaitMs({ message: 'Retry in 5 minutes' }, 'test.preferred.retry')).toBeUndefined();
    expect(await readRetryWaitMs({ message: 'Retry in 10 minutes' }, 'test.preferred.retry')).toBeUndefined();
    expect(await redactConfigValue('provider.model', 'fixture-general-model')).toBe('fixture-general-model');
  });
  expect(fake.requests).toHaveLength(1);
});
