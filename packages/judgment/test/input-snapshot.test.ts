import { expect, spyOn, test } from 'bun:test';
import { captureJudgmentInput } from '../src/port/input-snapshot.ts';
import { createSystemOnePort, SqliteDecisionLog, withDecisionLog } from '../src/index.ts';

const questions = () => ({ q: { type: 'noul' as const, instructions: 'Original question?' } });
const response = () => Response.json({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 2, output_tokens: 1 } });
const endpoint = { kind: 'hosted' as const, baseURL: 'https://snapshot.test', apiKey: 'fixture-key' };

test('only genuine captured pairs reuse input across request envelopes, without retaining request authority', () => {
  const source = { state: { nested: { value: 'original' } }, questions: questions() };
  const input = captureJudgmentInput(source, { immutable: true });
  source.state.nested.value = 'changed'; source.questions.q.instructions = 'Changed question';
  expect(input.state).toEqual({ nested: { value: 'original' } });
  expect(input.questions.q.instructions).toBe('Original question?');
  expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.questions.q)).toBe(true);
  const nextRequest = { ...input, signal: new AbortController().signal, context: { site: 'different-call' }, beforeAttempt() {} };
  expect(captureJudgmentInput(nextRequest)).toBe(input);
  expect(Object.keys(input)).toEqual(['state', 'questions']);
  expect(captureJudgmentInput({ ...input, state: { nested: { value: 'original' } } })).not.toBe(input);
  expect(captureJudgmentInput({ ...input, questions: { ...input.questions } })).not.toBe(input);
});

test('frozen lookalikes still detach mutable children rather than acquiring provenance', () => {
  const nested = { value: 'original' }, question = { type: 'noul' as const, instructions: 'Original question?' };
  const borrowed = Object.freeze({ state: Object.freeze({ nested }), questions: Object.freeze({ q: question }) });
  const input = captureJudgmentInput(borrowed);
  expect(input.state).not.toBe(borrowed.state); expect(input.questions).not.toBe(borrowed.questions);
  nested.value = 'changed'; question.instructions = 'Changed question';
  expect(input.state).toEqual({ nested: { value: 'original' } });
  expect(input.questions.q.instructions).toBe('Original question?');
});

test('a recorded real wire call clones its complete payload at most once and accepts the direct provider result', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const bodies: unknown[] = [];
  let guards = 0;
  const port = createSystemOnePort({ endpoint, model: 'jev-1.13.0', signal: new AbortController().signal, timeoutMs: 1000, retry: {},
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response(); } });
  const source = { state: { message: 'Complete original state '.repeat(1024) }, questions: questions(), beforeAttempt() { guards++; } };
  const parse = JSON.parse;
  const parsing = spyOn(JSON, 'parse');
  try {
    const result = await withDecisionLog(port, log).ask(source);
    const clonedPayloads = parsing.mock.calls.filter(([text]) => {
      if (typeof text !== 'string') return false;
      let value: unknown;
      try { value = parse(text); } catch { return false; }
      return value !== null && typeof value === 'object' && Object.keys(value).length === 2
        && Object.hasOwn(value, 'state') && Object.hasOwn(value, 'questions');
    });
    expect(clonedPayloads.length).toBeLessThanOrEqual(1);
    expect(bodies).toEqual([{ state: source.state, questions: source.questions, model: 'jev-1.13.0' }]);
    expect(result.answers.q.noul).toBe(0.9); expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
    expect(guards).toBe(1); expect(log.query()).toHaveLength(1);
  } finally { parsing.mockRestore(); }
});

test.each([false, true])('direct and recorded calls retain their captured input across an asynchronous guard (recorded=%s)', async recorded => {
  using log = new SqliteDecisionLog(':memory:');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const bodies: unknown[] = [];
  const wire = createSystemOnePort({ endpoint, model: 'jev-1.13.0', signal: new AbortController().signal, timeoutMs: 1000, retry: {},
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response(); } });
  const source = { state: { message: 'original' }, questions: questions(), async beforeAsyncAttempt() { entered.resolve(); await release.promise; } };
  const work = (recorded ? withDecisionLog(wire, log) : wire).ask(source);
  try {
    await entered.promise;
    source.state.message = 'changed'; source.questions.q.instructions = 'Changed question';
  } finally { release.resolve(); }
  expect((await work).answers.q.noul).toBe(0.9);
  expect(bodies).toEqual([{ state: { message: 'original' }, questions: questions(), model: 'jev-1.13.0' }]);
});

test('recognized payload data never restores an earlier cancellation owner', async () => {
  let calls = 0;
  const wire = createSystemOnePort({ endpoint, model: 'jev-1.13.0', signal: new AbortController().signal, timeoutMs: 1000, retry: {},
    fetch: async () => { calls++; return response(); } });
  const input = captureJudgmentInput({ state: 'original', questions: questions() }, { immutable: true });
  const controller = new AbortController(); controller.abort();
  await expect(wire.ask({ ...input, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
  expect(calls).toBe(0);
});
