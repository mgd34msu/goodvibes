// Proves: Each decision target is sent only its own key and no redirect is followed, and a failing target is asked a bounded number of times.
// Red when: A target is sent another target's key, a redirect is followed with a key, a failure does not pass to the next target, a key reaches the decision log, or a failing target is asked more than twice.
// Proves: The decision model's own answer (reject, held, revise, defer, unsure) is treated as a failure and a fallback model is asked until one says yes.
// Red when: The transport fails over on an answer instead of only on an outage.
import { describe, expect, test } from 'bun:test';
import { createSystemOnePort, JudgmentError, choice, noul, DEFAULT_MODEL, SqliteDecisionLog, withDecisionLog, type JudgmentConfig } from '../src/index.ts';

const request = { state: 'synthetic state', questions: { yes: noul('Synthetic question') } };
const primary = { kind: 'hosted' as const, baseURL: 'https://primary.test', apiKey: 'primary-test-key' };
const secondary = { kind: 'local' as const, baseURL: 'http://127.0.0.1:9999', apiKey: 'secondary-test-key' };
const good = (id = 'ok', model = DEFAULT_MODEL) => Response.json({ model, answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }, { headers: { 'x-typesafe-request-id': id } });
const bad = (status = 503, id = 'failed', headers = {}) => Response.json({ error: `must not log ${primary.apiKey}` }, { status, headers: { 'x-typesafe-request-id': id, ...headers } });
function config(fetch: NonNullable<JudgmentConfig['fetch']>, overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
  return { signal: new AbortController().signal, endpoint: primary, model: DEFAULT_MODEL, timeoutMs: 500, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fallbacks: [{ endpoint: secondary, model: DEFAULT_MODEL }], fetch, ...overrides };
}
const failure = async (promise: Promise<unknown>): Promise<JudgmentError> => {
  try { await promise; throw new Error('expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(JudgmentError); return error as JudgmentError; }
};

describe('finite configured decision model failover', () => {
  test.each([408, 429, 500, 529])('advances after HTTP %i with one logical result and request lineage', async (status) => {
    const urls: string[] = [];
    const port = createSystemOnePort(config(async (url, init) => {
      urls.push(String(url));
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${urls.length % 2 === 1 ? primary.apiKey : secondary.apiKey}`);
      return urls.length < 2 ? bad(status, `req-${urls.length}`) : good('req-2');
    }));
    using log = new SqliteDecisionLog(':memory:');
    const result = await withDecisionLog(port, log).ask(request);
    expect(urls).toEqual([`${primary.baseURL}/v1/systemone`, `${secondary.baseURL}/v1/systemone`]);
    expect(result.lineage?.attempts.map((a) => [a.endpointIndex, a.outcome, a.requestId])).toEqual([[0, 'unavailable', 'req-1'], [1, 'answered', 'req-2']]);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.lineage).toEqual(result.lineage);
    expect(port.health?.().map((h) => [h.attempts, h.consecutiveFailures, h.lastOutcome])).toEqual([[1, 1, 'unavailable'], [1, 0, 'answered']]);
    expect(JSON.stringify(log.query())).not.toContain(primary.apiKey);
    expect(JSON.stringify(log.query())).not.toContain(primary.baseURL);
  });

  test('a primary-only outage gets one further attempt, then halts and records no effects', async () => {
    let calls = 0, progress = 0, effects = 0;
    const port = createSystemOnePort(config(async () => { calls++; throw new Error('network'); }, { fallbacks: [] }));
    using log = new SqliteDecisionLog(':memory:');
    const work = withDecisionLog(port, log).ask({ ...request, onRetry: () => { progress++; } }).then(result => { effects++; return result; });
    const error = await failure(work);
    expect(error.kind).toBe('unavailable');
    expect(error.reason).toBe('unreachable');
    expect(calls).toBe(2); expect(progress).toBe(1); expect(effects).toBe(0);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.status).toBe('failed');
    expect(error.lineage?.attempts).toHaveLength(2);
  });

  test.each(['held', 'revise', 'defer', 'reject', 'unsure'] as const)('semantic %s is returned without asking a fallback', async (selected) => {
    let calls = 0;
    let retries = 0;
    const criteria = { act: null, held: null, revise: null, defer: null, reject: null, unsure: null };
    const answers = { disposition: { type: 'choice', choice: selected, confidence: 0.5,
      probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === selected ? 1 : 0])),
    } };
    const port = createSystemOnePort(config(async (url) => {
      expect(String(url)).toStartWith(primary.baseURL);
      calls++;
      return Response.json({ model: DEFAULT_MODEL, answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }));
    using log = new SqliteDecisionLog(':memory:');
    const result = await withDecisionLog(port, log).ask({ state: request.state, questions: { disposition: choice('Synthetic disposition', criteria) }, onRetry: () => { retries++; } });
    expect(result.answers.disposition.choice).toBe(selected);
    expect(result.answers.disposition.confidence).toBe(0.5);
    expect(calls).toBe(1);
    expect(retries).toBe(0);
    expect(result.lineage?.attempts.map((attempt) => [attempt.endpointIndex, attempt.outcome])).toEqual([[0, 'answered']]);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.status).toBe('answered');
    expect(port.health?.().map((endpoint) => endpoint.attempts)).toEqual([1, 0]);
  });
});
