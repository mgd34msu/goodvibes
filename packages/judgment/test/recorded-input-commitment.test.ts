/** Source regression UNRUN during the coding-first pass. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { recordedJudgmentInputHash, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '../src/index.ts';

const borrowed: JudgmentPort = { model: 'jev-fixture', async ask(request) {
  return { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.1 }])) as never,
    requestedModel: request.model ?? 'jev-fixture', model: 'jev-fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined };
} };
const questions = { q: { type: 'noul', instructions: 'Does this require action?' } } as const;

test('only the original saved result and matching input recover its existing private-state commitment with zero new hashes', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const request = { state: { nested: { text: 'PRIVATE_CALLER_CONTENT' } }, questions, context: { site: 'actual.original-site' } };
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
  const request = { state: { nested: { text: 'actual' } }, questions };
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
  const request = { state: { exact: 'Original actual state' }, questions, context: { site: 'actual.original-site' } }, port = withDecisionLog(borrowed, log);
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
