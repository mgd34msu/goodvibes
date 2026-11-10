/** Configured model/fallback regression source; not executed during the coding pass. */
import { expect, test } from 'bun:test';
import { createSystemOnePort, DECISION_MODEL_PROFILES, observeJudgmentModel, reuseObservedJudgmentResult,
  SqliteDecisionLog, withDecisionLog, type JudgmentConfig, type JudgmentEndpoint, type Questions } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureTriageJudgment } from '../platform/src/platform/intake/triage/model-result.js';
import { scoreInboxTriage } from '../platform/src/platform/intake/triage/scorer.js';
import { checkTriageReceipt } from '../platform/src/platform/intake/triage/evidence.js';
import { prepareJudgmentResult } from '../platform/src/platform/gate/judgment-result.js';
import { readCustomTagMeaning } from '../platform/src/platform/intake/triage/tagger/meaning.js';

const item = { id: 'synthetic-one', surface: 'synthetic', subject: 'A routine synthetic update' };
const signal = () => new AbortController().signal;
const reply = (model: string, questions: Questions, choice = false) => ({ model,
  answers: Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    if (choice && question.type === 'choice') {
      const selected = 'normal' in question.criteria ? 'normal' : 'act';
      return [name, { type: 'choice', choice: selected, confidence: .99, x_jev_confidence: .99,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) }];
    }
    return [name, { type: 'noul', noul: .01 }];
  })), usage: { input_tokens: 19, output_tokens: 2, truncated: false } });

for (const profile of DECISION_MODEL_PROFILES) {
  test(`triage delegates selection to the configured ${profile.name} native adapter`, async () => {
    const cloudflare = profile.adapter === 'cloudflare-workers-ai';
    const endpoint: JudgmentEndpoint = cloudflare
      ? { kind: 'hosted', baseURL: `https://api.cloudflare.com/client/v4/accounts/test/ai/run/@cf/cloudflare/${profile.model}`, apiKey: 'fixture-key' }
      : { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none', adapter: profile.adapter,
        ...(profile.responseModels ? { responseModels: profile.responseModels } : {}) };
    const resolved = profile.responseModels?.[0] ?? profile.model;
    const requests: string[] = [];
    const port = createSystemOnePort({ endpoint, model: profile.model, signal: signal(), timeoutMs: 30_000, retry: {}, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; questions: Questions };
      requests.push(body.model); const result = reply(resolved, body.questions);
      return Response.json(cloudflare ? { success: true, result, errors: [], messages: [] } : result);
    } });
    const [receipt] = await scoreInboxTriage([item], port);
    if (!receipt) throw new Error('Actual triage fixture returned no receipt');
    expect(requests).toEqual([profile.model]);
    expect(receipt).toMatchObject({ receiptVersion: 4, status: 'settled', model: profile.model, actualModel: resolved, targetModel: profile.model });
    expect(checkTriageReceipt(receipt)).toEqual(receipt);
  });
}

const fallbackConfig = (choice = false): JudgmentConfig => ({
  endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9100', apiKey: '', authentication: 'none' },
  model: 'jev-latest', signal: signal(), timeoutMs: 30_000, retry: {},
  fallbacks: [{ model: 'english', endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9200', apiKey: '', authentication: 'none', adapter: 'laya', responseModels: ['laya-rl-agent'] } }],
  fetch: async (url, init) => String(url).includes(':9100') ? Response.json({}, { status: 503 })
    : Response.json(reply('laya-rl-agent', (JSON.parse(String(init?.body)) as { questions: Questions }).questions, choice)),
});

test('actual fallback attribution survives log projection and complete strict-result admission', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const native = createSystemOnePort(fallbackConfig());
  const logged = withDecisionLog(native, log);
  const port = { get model() { return logged.model; }, async ask<const Q extends import('@goodvibes-jev/judgment').Questions>(request: import('@goodvibes-jev/judgment').JudgmentRequest<Q>) {
    const frame = prepareJudgmentResult(request.questions);
    return frame.capture(await logged.ask({ ...request, captureResult: value => frame.capture(value) }));
  } };
  const [receipt] = await scoreInboxTriage([item], port);
  expect(receipt).toMatchObject({ status: 'settled', model: 'jev-latest', actualModel: 'laya-rl-agent', targetModel: 'english' });
  expect(log.query()[0]).toMatchObject({ requestedModel: 'jev-latest', model: 'laya-rl-agent' });
});

test('custom tag meaning uses configured fallback and records its real model', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const port = withDecisionLog(createSystemOnePort(fallbackConfig(true)), log);
  const value = await readCustomTagMeaning('Routine correspondence', port, { signal: signal(), assertCurrent() {} });
  expect(value.canonical).toBe('GoodVibes/Normal');
  expect(log.query()[0]).toMatchObject({ requestedModel: 'jev-latest', model: 'laya-rl-agent' });
});

test('native model proof cannot be obtained by copying valid results or forgeable lineage', async () => {
  const native = createSystemOnePort(fallbackConfig());
  const request = { state: 'Synthetic input', questions: { yes: { type: 'noul' as const, instructions: 'Synthetic?' } } };
  const original = await native.ask(request);
  expect(observeJudgmentModel(original)).toMatchObject({ targetModel: 'english' });
  expect(Object.isFrozen(original)).toBe(true); expect(Object.isFrozen(original.answers)).toBe(true);
  const copied = { ...original };
  expect(observeJudgmentModel(copied)).toBeUndefined();
  expect(reuseObservedJudgmentResult(copied, copied)).toBe(copied);
  const forged = { model: 'jev-latest', async ask() { return copied as never; } };
  expect((await scoreInboxTriage([item], forged))[0]?.status).toBe('unavailable');
});

test('unavailable receipts do not invent a requested or answered model; historical receipts remain readable', async () => {
  const [unavailable] = await scoreInboxTriage([item]);
  if (!unavailable) throw new Error('Missing unavailable receipt');
  expect(unavailable).toMatchObject({ receiptVersion: 3, status: 'unavailable' });
  expect(Object.hasOwn(unavailable, 'inputHash')).toBe(false);
  expect(unavailable?.model).toBeUndefined(); expect(unavailable?.actualModel).toBeUndefined();
  expect(checkTriageReceipt(unavailable)).toEqual(unavailable);
  const historical: Record<string, unknown> = { ...unavailable, inputHash: 'a'.repeat(64), status: 'unavailable', model: 'jev-latest' };
  delete historical.receiptVersion; expect<unknown>(checkTriageReceipt(historical)).toEqual(historical);
});

test('a borrowed recorder getter is rejected without executing user code', async () => {
  let executed = 0;
  const port = { model: 'english', get recorder(): never { executed++; throw new Error('must not run'); }, async ask(): Promise<never> { throw new Error('not asked'); } };
  await expect(readCustomTagMeaning('Routine', port, { signal: signal(), assertCurrent() {} })).rejects.toThrow();
  expect(executed).toBe(0);
});

 test('recording accepts configured model selectors containing @ without hiding actual attribution', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const model = '@local/decision';
  const port = withDecisionLog(createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9300', apiKey: '', authentication: 'none' },
    model, signal: signal(), timeoutMs: 30_000, retry: {}, fetch: async (_url, init) => Response.json(reply(model, (JSON.parse(String(init?.body)) as { questions: Questions }).questions)),
  }), log);
  expect((await scoreInboxTriage([item], port))[0]).toMatchObject({ status: 'settled', model, actualModel: model });
  expect(log.query()[0]).toMatchObject({ status: 'answered', requestedModel: model, model });
});

 test('strict caller restrictions retain already-admitted borrowed snapshot identity without minting native proof', async () => {
  const fake = fakePort(() => noulAnswer(.01));
  const questions = { yes: { type: 'noul' as const, instructions: 'Synthetic?' } };
  const raw = await fake.port.ask({ state: 'Synthetic', questions });
  const frame = prepareJudgmentResult(questions), admitted = frame.capture(raw);
  expect(admitted).not.toBe(raw);
  const restricted = captureTriageJudgment(admitted, questions).result;
  expect(restricted).toBe(admitted);
  expect(observeJudgmentModel(restricted)).toBeUndefined();
  const detached = captureTriageJudgment(raw, questions).result;
  expect(detached).not.toBe(raw); expect(Object.isFrozen(detached)).toBe(true);
});
