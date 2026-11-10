/** Source regression UNRUN during the coding-first pass. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { JudgmentError, recordedJudgmentInputHash, SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest } from '../src/index.ts';

const borrowed: JudgmentPort = { model: 'jev-fixture', async ask(request) {
  return { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.1 }])) as never,
    requestedModel: request.model ?? 'jev-fixture', model: 'jev-fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined };
} };
const questions = { q: { type: 'noul', instructions: 'Does this require action?' } } as const;

test('only the original saved result and matching input recover its existing private-state commitment with zero new hashes', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const request = { state: { nested: { text: 'PRIVATE_CALLER_CONTENT' } }, questions, context: { site: 'actual.original-site' }, inputBinding: 'state' as const };
  const original = await withDecisionLog(borrowed, log).ask(request);
  const row = log.get(original.decisionId!);
  expect(row?.status).toBe('answered');
  const hashes = spyOn(crypto, 'createHash'), stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    expect(recordedJudgmentInputHash(original, request)).toBe(row!.stateHash);
    expect(recordedJudgmentInputHash(original, structuredClone(request))).toBe(row!.stateHash);
    expect(recordedJudgmentInputHash(structuredClone(original), request)).toBeUndefined();
    expect(recordedJudgmentInputHash(original, { ...request, context: { site: 'different-site' } })).toBeUndefined();
    expect(recordedJudgmentInputHash({ ...original }, request)).toBeUndefined();
    const hidden = { nested: Object.defineProperty({}, 'text', { value: 'PRIVATE_CALLER_CONTENT', enumerable: false }) };
    expect(recordedJudgmentInputHash(original, { state: hidden, questions })).toBeUndefined();
    expect(recordedJudgmentInputHash(original, { ...request, questions: { q: { type: 'noul', instructions: 'A different exact question' } } })).toBeUndefined();
    request.state.nested.text = 'Changed after the actual recorded call';
    expect(recordedJudgmentInputHash(original, request)).toBeUndefined();
    expect(recordedJudgmentInputHash(original, { state: { nested: { text: 'PRIVATE_CALLER_CONTENT' } }, questions, context: request.context })).toBe(row!.stateHash);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(JSON.stringify(original)).not.toContain('PRIVATE_CALLER_CONTENT');
    expect(row).not.toHaveProperty('state');
  } finally { stateHashes.mockRestore(); hashes.mockRestore(); }
});

test('commitment lookup never executes borrowed accessors or proxy traps to manufacture a matching state', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const request = { state: { nested: { text: 'actual' } }, questions, inputBinding: 'state' as const };
  const original = await withDecisionLog(borrowed, log).ask(request);
  let reads = 0;
  const nested = { nested: Object.defineProperty({}, 'text', { enumerable: true, get() { reads++; return 'actual'; } }) };
  expect(recordedJudgmentInputHash(original, { state: nested, questions })).toBeUndefined();
  expect(recordedJudgmentInputHash(original, Object.defineProperty({ questions }, 'state', { get() { reads++; return request.state; } }))).toBeUndefined();
  const proxy = new Proxy(request, { getOwnPropertyDescriptor() { reads++; throw new Error('Borrowed proxy must stay unread'); } });
  expect(recordedJudgmentInputHash(original, proxy)).toBeUndefined();
  expect(reads).toBe(0);
  expect(recordedJudgmentInputHash({}, request)).toBeUndefined();
});

test('later WeakMap and Reflect overrides cannot relabel an unrelated actual logged call as this input', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const request = { state: { exact: 'Original actual state' }, questions, context: { site: 'actual.original-site' }, inputBinding: 'state' as const }, port = withDecisionLog(borrowed, log);
  const original = await port.ask(request), foreign = { ...original }, changed = { ...request, state: { exact: 'Different supplied state' } };
  const row = log.get(original.decisionId!)!;
  const forged = { state: changed.state, questions, context: changed.context, decisionId: original.decisionId, stateHash: row.stateHash };
  const get = WeakMap.prototype.get, apply = Reflect.apply; const observations: Array<string | undefined> = [];
  try {
    WeakMap.prototype.get = () => forged; Reflect.apply = (() => forged) as typeof Reflect.apply;
    observations.push(recordedJudgmentInputHash(foreign, changed), recordedJudgmentInputHash(original, changed), recordedJudgmentInputHash(original, request));
  } finally { WeakMap.prototype.get = get; Reflect.apply = apply; }
  expect(observations).toEqual([undefined, undefined, row.stateHash]);
});

test('ordinary answered audit calls have no state digest or recoverable private input commitment', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const request = { state: { private: 'Never retained behind an ordinary audit result' }, questions };
    const result = await withDecisionLog(borrowed, log).ask(request);
    expect(log.get(result.decisionId!)?.status).toBe('answered');
    expect(log.get(result.decisionId!)).not.toHaveProperty('stateHash');
    expect(recordedJudgmentInputHash(result, request)).toBeUndefined();
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { stateHashes.mockRestore(); }
});

test('explicit successful proofs preserve the existing canonical commitment and coexist with unbound log rows', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const port = withDecisionLog(borrowed, log);
  const bound = await port.ask({ state: { message: 'Payouts failing for 3 days' }, questions, inputBinding: 'state' });
  const unbound = await port.ask({ state: { message: 'Payouts failing for 3 days' }, questions });
  // Independently pinned canonical-state digest; do not derive the expected
  // value by calling the implementation being exercised.
  expect(log.get(bound.decisionId!)?.stateHash).toBe('f4c8dfe18fb3814ce2c19b8ca80bc7d6ec6a979d770cafae346e532aa66b6bcf');
  expect(log.get(unbound.decisionId!)).not.toHaveProperty('stateHash');
  expect(log.query({ status: 'answered' })).toHaveLength(2);
});

test('failed, invalid and cancelled calls never compute a state digest even with explicit proof binding', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const failure: JudgmentPort = { model: borrowed.model, async ask() { throw new JudgmentError('unavailable', 'private upstream text'); } };
  const invalid: JudgmentPort = { model: borrowed.model, async ask(request) { return { ...await borrowed.ask(request), model: 'https://unsafe-model.test' }; } };
  const controller = new AbortController(); controller.abort();
  const during = new AbortController();
  const cancelled: JudgmentPort = { model: borrowed.model, async ask(request) { const result = await borrowed.ask(request); during.abort(); return result; } };
  const stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    for (const [inner, signal] of [[failure, undefined], [invalid, undefined], [borrowed, controller.signal], [cancelled, during.signal]] as const) {
      const result = await withDecisionLog(inner, log).ask({ state: { private: 'No failed proof' }, questions, inputBinding: 'state', ...(signal ? { signal } : {}) }).catch(error => error);
      expect(result).toBeInstanceOf(JudgmentError);
    }
    await expect(withDecisionLog(borrowed, log).ask({ state: 'private', questions, inputBinding: 'state',
      captureResult() { throw new JudgmentError('invalid-response', 'The complete response was not admitted'); },
    })).rejects.toBeInstanceOf(JudgmentError);
    expect(log.query({ status: 'failed' })).toHaveLength(5);
    expect(log.query({ status: 'failed' }).every(entry => !Object.hasOwn(entry, 'stateHash'))).toBe(true);
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { stateHashes.mockRestore(); }
});

test('proof binding is captured once and only a validated answered response computes its saved commitment', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let reads = 0;
  const request = Object.defineProperty({ state: { exact: 'admitted original' }, questions }, 'inputBinding', {
    enumerable: true, get() { reads++; return reads === 1 ? 'state' : undefined; },
  });
  const stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const result = await withDecisionLog(borrowed, log).ask(request);
    const entry = log.get(result.decisionId!);
    expect(reads).toBe(1);
    expect(entry?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recordedJudgmentInputHash(result, request)).toBe(entry!.stateHash);
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
  } finally { stateHashes.mockRestore(); }
});

test('malformed borrowed proof-binding options cannot request hashing or provider dispatch', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let calls = 0;
  const inner: JudgmentPort = { model: borrowed.model, async ask(request) { calls++; return borrowed.ask(request); } };
  const stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const request = { state: 'private', questions, inputBinding: 'anything' } as unknown as JudgmentRequest<typeof questions>;
    await expect(withDecisionLog(inner, log).ask(request)).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(calls).toBe(0);
    expect(log.query({ status: 'failed' })[0]).not.toHaveProperty('stateHash');
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { stateHashes.mockRestore(); }
});

for (const mode of ['return', 'throw', 'retention-refusal'] as const) test(`malformed proof binding ${mode} drains owned rejected work without dispatch or hashing`, async () => {
  using log = new SqliteDecisionLog(':memory:');
  const work = Promise.withResolvers<void>();
  let calls = 0, reads = 0;
  Object.defineProperty(work.promise, 'then', { get() { reads++; throw new Error('Borrowed then must not be read'); } });
  const inner: JudgmentPort = { model: borrowed.model, async ask(request) { calls++; return borrowed.ask(request); } };
  const request = Object.defineProperty({ state: 'private', questions,
    ...(mode === 'retention-refusal' ? { assertLogCurrent() { throw new Error('Retention refused'); } } : {}),
  }, 'inputBinding', { enumerable: true, get() { if (mode === 'throw') throw work.promise; return work.promise; } });
  const stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    await expect(withDecisionLog(inner, log).ask(request)).rejects.toMatchObject({ kind: mode === 'return' ? 'invalid-request' : 'rejected' });
    expect(calls).toBe(0);
    expect(reads).toBe(0);
    expect(log.query().every(entry => !Object.hasOwn(entry, 'stateHash'))).toBe(true);
    expect(log.query()).toHaveLength(mode === 'return' ? 1 : 0);
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    // Reject after refusal: the test runner observes unhandled rejection if
    // the malformed returned/thrown Promise was dropped instead of drained.
    work.reject(new Error('Late invalid proof-binding work'));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(0);
  } finally { stateHashes.mockRestore(); }
});

test('malformed plain and proxy proof-binding thenables are never assimilated', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let calls = 0, reads = 0;
  const inner: JudgmentPort = { model: borrowed.model, async ask(request) { calls++; return borrowed.ask(request); } };
  const values = [
    { get then() { reads++; throw new Error('Plain thenable getter'); } },
    new Proxy({}, { get() { reads++; throw new Error('Proxy thenable getter'); } }),
  ];
  const stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    for (const inputBinding of values) {
      const request = { state: 'private', questions, inputBinding } as unknown as JudgmentRequest<typeof questions>;
      await expect(withDecisionLog(inner, log).ask(request)).rejects.toMatchObject({ kind: 'invalid-request' });
    }
    expect(calls).toBe(0); expect(reads).toBe(0);
    expect(log.query()).toHaveLength(2);
    expect(log.query().every(entry => !Object.hasOwn(entry, 'stateHash'))).toBe(true);
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { stateHashes.mockRestore(); }
});
