// Proves: A decision a tool call or a person waits on never settles when the decision endpoint is silent.
// Red when: judge() stops applying its deadline, so an unattended turn waits for ever with nobody told.
// Proves: A decision the model is unsure about is never acted on; the caller's fallback (ask) applies.
// Red when: A 0.5 reading on a medium-stakes question settles to an answer instead of the fallback. No engine test covers an unsure reading; judge() is called from exec, edit, credential-header and hook decisions.
import { describe, expect, test } from 'bun:test';
import {
  createJudgeCache,
  defineBattery,
  DEFAULT_MODEL,
  judge,
  STAKES_BANDS,
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
});
