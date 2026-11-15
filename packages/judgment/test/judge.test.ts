import { describe, expect, test } from 'bun:test';
import {
  createJudgeCache,
  createSystemOnePort,
  defineBattery,
  DEFAULT_MODEL,
  judge,
  SqliteDecisionLog,
  STAKES_BANDS,
  withDecisionLog,
  yesNo,
  type JudgmentPort,
} from '../src/index.ts';
import { fakePort, noulAnswer } from '../src/testing/index.ts';

const reachesNetwork = defineBattery({
  name: 'test.judge-network',
  version: 1,
  description: 'Whether a command reaches the network.',
  accuracyFloor: 0.8,
  items: { network: yesNo('Does `command` reach the network?', STAKES_BANDS.medium.yesNo) },
  fixtures: [{ name: 'curl', state: { command: 'curl example.test' }, expect: { network: 'yes' } }],
});

type Needs = 'network' | 'local' | 'ask';
const settle = (readings: { readonly network: { readonly verdict: 'yes' | 'no' | 'uncertain' } }): Needs | undefined =>
  readings.network.verdict === 'uncertain' ? undefined : readings.network.verdict === 'yes' ? 'network' : 'local';
const options = (port: JudgmentPort | undefined, key: string) => ({
  port, site: 'test.judge', battery: reachesNetwork, state: { command: key },
  settle, fallback: (): Needs => 'ask',
});

describe('judge', () => {
  test('a cached answer, policy off and a missing port cost no request', async () => {
    const fake = fakePort(() => noulAnswer(0.02));
    const first = await judge({ ...options(fake.port, 'ls'), cache: { key: 'ls', scope: 'process' } });
    const second = await judge({ ...options(fake.port, 'ls'), cache: { key: 'ls', scope: 'process' } });
    expect([first.value, first.source, second.value, second.source]).toEqual(['local', 'model', 'local', 'cache']);
    expect(fake.requests).toHaveLength(1);

    expect(await judge({ ...options(fake.port, 'ls'), off: true })).toEqual({ value: 'ask', source: 'fallback', why: 'off' });
    expect((await judge(options(undefined, 'ls'))).why).toBe('unavailable');
    expect(fake.requests).toHaveLength(1);
  });

  test('an unsure reading takes the fallback and is not asked again in the session', async () => {
    const fake = fakePort(() => noulAnswer(0.5));
    const session = createJudgeCache();
    const ask = () => judge({ ...options(fake.port, 'make deploy'), cache: { key: 'make deploy', scope: 'session', store: session } });
    expect(await ask()).toMatchObject({ value: 'ask', source: 'fallback', why: 'unsure' });
    expect(await ask()).toMatchObject({ value: 'ask', source: 'fallback', why: 'unsure' });
    expect(fake.requests).toHaveLength(1);
  });

  test('no answer within the deadline takes the fallback; the caller cancelling rejects', async () => {
    const silent: JudgmentPort = {
      model: DEFAULT_MODEL,
      ask: (request) => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
      }),
    };
    expect(await judge({ ...options(silent, 'git push'), deadlineMs: 5 })).toMatchObject({ value: 'ask', why: 'deadline' });
    const caller = new AbortController();
    const pending = judge({ ...options(silent, 'git push'), deadlineMs: 60_000, signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  test('a target that misses its deadline three times is skipped without a request', async () => {
    let wires = 0;
    const port = createSystemOnePort({
      endpoint: { kind: 'hosted', baseURL: 'https://primary.test', apiKey: 'test-key' },
      model: DEFAULT_MODEL, timeoutMs: 30_000, retry: {},
      fetch: async () => { wires++; return await new Promise<Response>(() => {}); },
    });
    for (let miss = 0; miss < 3; miss++) {
      expect((await judge({ ...options(port, `miss-${miss}`), deadlineMs: 5 })).why).toBe('deadline');
    }
    expect(wires).toBe(3);
    expect(await judge({ ...options(port, 'after'), deadlineMs: 5 })).toMatchObject({ value: 'ask', why: 'unavailable' });
    expect(wires).toBe(3);
  });

  test('the answer, its readings and the action are one decision-log entry', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const recorded = withDecisionLog(fakePort(() => noulAnswer(0.97)).port, log);
    const outcome = await judge({ ...options(recorded, 'curl example.test'), describe: needs => `needs:${needs}` });
    expect(outcome).toMatchObject({ value: 'network', source: 'model' });
    const entries = log.query();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.status !== 'answered') throw new Error('expected an answered entry');
    expect(String(entry.id)).toBe(outcome.decisionId!);
    expect(entry.context?.site).toBe('test.judge');
    expect(entry.notes.map(note => note.kind)).toEqual(['readings', 'action']);
    expect(entry.notes[1]).toEqual({ kind: 'action', action: 'needs:network' });
  });
});
