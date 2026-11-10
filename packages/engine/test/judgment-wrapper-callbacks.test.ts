import { expect, spyOn, test } from 'bun:test';
import { createSystemOnePort, DEFAULT_MODEL, noul, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { browserControlIdentity, browserCredentialPage, BrowserControlIdentityWork } from '../platform/src/platform/browser/browser-control-identity.js';
import { nativeContractPort } from '../platform/src/platform/contract/native-decisions.js';
import { nativeSourceCriteria } from '../platform/src/platform/contract/native-source.js';
import { makeContract } from './contract/fixtures.js';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const identity = { recorded: { name: 'Send message' }, current: { name: 'Submit message' } };

for (const mode of ['returned-work', 'retired-after-answer', 'valid'] as const) test(`actual browser wrapper preserves native recording guard: ${mode}`, async () => {
  using log = new SqliteDecisionLog(':memory:');
  let retired = false;
  const provider = fakePort(() => { if (mode === 'retired-after-answer') retired = true; return noulAnswer(0.99); });
  const previous = installJudgmentPort(withDecisionLog(provider.port, log));
  const pending = Promise.withResolvers<void>();
  const originalRun = browserControlIdentity.run.bind(browserControlIdentity);
  const run = spyOn(browserControlIdentity, 'run').mockImplementation((port, state, options) => originalRun({ ...port,
    ask(request) { return port.ask({ ...request, assertLogCurrent() {
      if (mode === 'returned-work') return pending.promise;
      if (retired) throw new Error('Private original retention refusal');
    } }); },
  }, state, options));
  try {
    const operation = new BrowserControlIdentityWork().sameControl(identity);
    if (mode === 'valid') {
      expect(await operation).toBe(true); expect(log.query()).toHaveLength(1); expect(provider.requests).toHaveLength(1);
    } else {
      await expect(operation).rejects.toMatchObject({ kind: 'rejected' });
      expect(log.query()).toEqual([]);
      expect(provider.requests).toHaveLength(mode === 'returned-work' ? 0 : 1);
    }
    // The valid/retired controls did not offer work to a guard.
    if (mode !== 'returned-work') void pending.promise.catch(() => {});
    pending.reject(new Error('Late refused work'));
    await tick();
  } finally { run.mockRestore(); installJudgmentPort(previous); }
});

test('actual browser and captured-owner async admission wrappers retain malformed resolved values for native rejection', async () => {
  let wires = 0, guards = 0;
  const base = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' },
    model: DEFAULT_MODEL, timeoutMs: 1000, signal: new AbortController().signal, retry: {},
    fetch: async () => { wires++; throw new Error('Unexpected dispatch'); },
  });
  const previous = installJudgmentPort(base);
  const originalRun = browserCredentialPage.run.bind(browserCredentialPage);
  // A void-typed function can return work at runtime; no type suppression is needed.
  const malformed: () => void = () => { guards++; return Promise.resolve('nonvoid admission'); };
  const run = spyOn(browserCredentialPage, 'run').mockImplementation((port, state, options) => originalRun({ ...port,
    ask(request) { return port.ask({ ...request, beforeAsyncAttempt: malformed }); },
  }, state, options));
  try {
    await expect(new BrowserControlIdentityWork().credentialPage({ url: 'https://fixture.test/', documents: [] }, async () => {})).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(guards).toBe(1); expect(wires).toBe(0);
  } finally { run.mockRestore(); installJudgmentPort(previous); }
});

for (const mode of ['settle', 'retire', 'host-rejects'] as const) test(`actual native contract retry drains both original observers before another attempt: ${mode}`, async () => {
  let wires = 0, revision = 'original';
  const order: string[] = [];
  const hostEntered = Promise.withResolvers<void>(), requestEntered = Promise.withResolvers<void>();
  const hostDrain = Promise.withResolvers<void>(), requestDrain = Promise.withResolvers<void>();
  const source = { sourceId: 'original-work', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1', goal: 'Preserve the parser', criteria: ['Keep every original form'] };
  const contract = makeContract({ nativeSource: source, goal: source.goal, criteria: nativeSourceCriteria(source) });
  const base = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'primary-fixture' },
    model: DEFAULT_MODEL, timeoutMs: 1000, signal: new AbortController().signal, retry: {},
    fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: 'backup-fixture' }, model: DEFAULT_MODEL }],
    fetch: async () => ++wires === 1 ? Response.json({}, { status: 503 }) : Response.json({ model: DEFAULT_MODEL,
      answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const port = nativeContractPort(contract, {
    host: {
      authorityOf: () => ({ authorityId: 'native-owner', authorityRevision: revision, scopeId: 'original-project', scopeRevision: '1' }),
      async onRetry() { order.push('host'); hostEntered.resolve(); await hostDrain.promise; if (mode === 'host-rejects') throw new Error('Original observer failed'); },
    }, changed() {},
  }, base);
  const outcome = port.ask({ state: 'Original synthetic request', questions: { yes: noul('Synthetic question') },
    async onRetry() { order.push('request'); requestEntered.resolve(); await requestDrain.promise; },
  }).then(result => ({ result }), (error: unknown) => ({ error }));
  try {
    await Promise.all([hostEntered.promise, requestEntered.promise]);
    expect(order).toEqual(['host', 'request']); expect(wires).toBe(1);
    hostDrain.resolve(); await tick(); expect(wires).toBe(1);
    if (mode === 'retire') revision = 'replaced';
    requestDrain.resolve();
    const settled = await outcome;
    if (mode === 'retire') { expect(settled).toHaveProperty('error'); expect(wires).toBe(1); }
    else { expect(settled).toHaveProperty('result'); expect(wires).toBe(2); }
    expect(contract.nativeWaiting).toBeUndefined();
  } finally { hostDrain.resolve(); requestDrain.resolve(); await outcome; }
});
