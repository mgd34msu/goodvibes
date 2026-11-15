import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readsAsBelowCacheMinimum, readsAsCopilotClaudeModel } from '../platform/src/platform/routing/provider-cache-readings.ts';
import { knownAnthropicOutputCapRow, readAnthropicOutputCapRow } from '../platform/src/platform/routing/model-limit-readings.ts';
import { readsAsAlternateApi } from '../platform/src/platform/routing/provider-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

test('a cache-minimum reading is made again after the decision port is replaced', async () => {
  const first = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(first.port);
  expect(await readsAsBelowCacheMinimum('content too short to cache', 'test.cache-minimum')).toBe(true);
  expect(await readsAsBelowCacheMinimum('content too short to cache', 'test.cache-minimum')).toBe(true);
  expect(first.requests).toHaveLength(1);

  const second = fakePort(() => noulAnswer(0.01));
  installJudgmentPort(second.port);
  expect(await readsAsBelowCacheMinimum('content too short to cache', 'test.cache-minimum')).toBe(false);
  expect(second.requests).toHaveLength(1);
});

test('a transport reading of a Copilot model id is made again after the decision port is replaced', async () => {
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  expect(await readsAsCopilotClaudeModel('vendor-model-1', 'test.copilot-transport')).toBe(true);
  installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  expect(await readsAsCopilotClaudeModel('vendor-model-1', 'test.copilot-transport')).toBe(false);
});

test('an output cap known under one decision port is not known under the next', async () => {
  const fake = fakePort((_name, question) => {
    if (question.type !== 'choice') throw new Error('unexpected question');
    return { type: 'choice', choice: 'none', confidence: 0.99, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === 'none' ? 1 : 0])) };
  });
  installJudgmentPort(fake.port);
  await readAnthropicOutputCapRow('some-model', 'test.output-cap');
  expect(knownAnthropicOutputCapRow('some-model')).toBeNull();
  installJudgmentPort({ ...fake.port, model: 'another-model' } as JudgmentPort);
  expect(knownAnthropicOutputCapRow('some-model')).toBeUndefined();
});

test('an alternate-api reading joined from another caller does not carry that caller\'s abort', async () => {
  const gate = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.99));
  const port: JudgmentPort = { ...fake.port, async ask(request) { await gate.promise; return fake.port.ask(request); } };
  installJudgmentPort(port);
  const error = { status: 400, message: 'unsupported on this endpoint' };
  const abortFirst = new AbortController();
  const first = readsAsAlternateApi(error, 'test.alternate-api', { signal: abortFirst.signal });
  const second = readsAsAlternateApi(error, 'test.alternate-api', {});
  await Promise.resolve();
  abortFirst.abort();
  await expect(first).rejects.toBeDefined();
  gate.resolve();
  expect(await second).toBe(true);
  expect(fake.requests).toHaveLength(1);
});
