import { screeningAnswers } from './_helpers/screening-answers.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createProtectedSourceOwner } from '../platform/src/platform/security/source-screening/owner.js';
import type { ProtectedSourceOwner, ProtectedSourceOwnerOptions, SourceScreeningReceipt,
} from '../platform/src/platform/security/source-screening/types.js';
import { createProtectedInboxMapper } from '../platform/src/platform/intake/protected-preview.js';
import { createSlackInboxAdapter } from '../platform/src/platform/intake/providers/slack.js';
import { registerInboxSurface } from '../platform/src/platform/intake/registration.js';
import { InboxCursorStore } from '../platform/src/platform/intake/cursor-store.js';
import { digestSender } from '../platform/src/platform/intake/text-normalization.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
interface Proposal { readonly revision: string; readonly parts: readonly string[]; }
function fixture(options: {
  propose?: (source: Proposal) => unknown | Promise<unknown>;
  judge?: (body: Record<string, unknown>, count: number) => Response | Promise<Response>;
  authority?: () => void;
  onRetry?: ProtectedSourceOwnerOptions['onRetry'];
} = {},
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let judgmentCalls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    const path = new URL(request.url).pathname; calls.push({ path, body });
    if (path === '/v1/chat/completions') {
      const messages = body['messages'] as { content: string }[];
      const source = JSON.parse(messages[1]!.content) as Proposal;
      const proposed = options.propose ? await options.propose(source) : { revision: source.revision, spans: [] };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposed) } }] });
    }
    if (path !== '/v1/systemone') return new Response('', { status: 404 });
    judgmentCalls++;
    return options.judge ? options.judge(body, judgmentCalls) : reading(body, 1, 1);
  },
  });
  const lifetime = new AbortController();
  const config: ProtectedSourceOwnerOptions = {
    authority: { ownerId: 'synthetic-owner', revision: '1', retention: 'ephemeral-no-log', signal: lifetime.signal, assertCurrent: options.authority ?? (() => {}),
    },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'local-span-fixture' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' },
    timeoutMs: 1_000,
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
  };
  const owner = createProtectedSourceOwner(config);
  cleanups.push(async () => { await owner.close(); await server.stop(true); });
  return { owner, calls, config, lifetime };
}
function reading(body: Record<string, unknown>, complete: number, precise: number, model = 'jev-1.13.0') {
  return Response.json({ model, answers: screeningAnswers(body, { complete: complete, precise: precise }), usage: { input_tokens: 10, output_tokens: 2 },
  });
}
async function projected(owner: ProtectedSourceOwner, parts: readonly string[]) {
  const result = await owner.screen(owner.capture(parts));
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') throw new Error('Fixture did not settle');
  return { parts: owner.project(result.receipt), receipt: result.receipt };
}

test('actual local proposal and Jev preserve original content except verified exact spans', async () => {
  const text = 'Call person@example.test, then keep the build notes. 🙂';
  const { owner, calls } = fixture({ propose: (source) => ({ revision: source.revision, spans: [{ part: 1, start: 5, end: 24 }] }) });
  expect((await projected(owner, ['Direct message', text])).parts).toEqual(['Direct message', 'Call [redacted], then keep the build notes. 🙂',
  ]);
  expect(calls.map((call) => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
  expect(calls[1]!.body['state']).toMatchObject({ parts: ['Direct message', text], spans: [{ part: 1, start: 5, end: 24 }] });
});

test('source and configured routes are captured before asynchronous work, and repeated calls coalesce', async () => {
  const gate = deferred<void>(), started = deferred<void>();
  const f = fixture({ propose: async (source) => { started.resolve(); await gate.promise; return { revision: source.revision, spans: [] }; },
  });
  const parts = ['Original sentence.']; const handle = f.owner.capture(parts); parts[0] = 'Changed.';
  const pending = f.owner.screen(handle); expect(f.owner.screen(handle)).toBe(pending); await started.promise;
  (f.config.proposal as { endpoint: string }).endpoint = 'https://forbidden.example';
  gate.resolve(); const result = await pending; expect(result.status).toBe('settled');
  if (result.status === 'settled') expect(f.owner.project(result.receipt)).toEqual(['Original sentence.']);
  expect(f.calls).toHaveLength(2);
});

test.each([0.5, 0.97, 0])('semantic uncertainty or refusal %s releases no text and is not retried for a lucky answer', async (probability) => {
  const f = fixture({ judge: (body) => reading(body, probability, 1) }); const handle = f.owner.capture(['Keep this ordinary sentence.']);
  expect(await f.owner.screen(handle)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(await f.owner.screen(handle)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(f.calls).toHaveLength(2);
  expect(() => f.owner.project({} as SourceScreeningReceipt)).toThrow('handle is not current');
},
);

test('foreign/forged/released receipts cannot be used as privacy authority', async () => {
  const a = fixture(), b = fixture(); const handle = a.owner.capture(['Ordinary text.']);
  const result = await a.owner.screen(handle); expect(result.status).toBe('settled'); if (result.status !== 'settled') return;
  expect(() => b.owner.project(result.receipt)).toThrow(); expect(() => a.owner.project({ ...result.receipt })).toThrow();
  await a.owner.release(handle); expect(() => a.owner.project(result.receipt)).toThrow();
  expect(await a.owner.screen(handle)).toEqual({ status: 'held', reason: 'stale' });
});

test('a genuine display-preview receipt is not query-role authority', async () => {
  const { owner } = fixture();
  const result = await projected(owner, ['Ordinary source.']);
  expect(() => owner.projectResearchReference(result.receipt as unknown as Parameters<typeof owner.projectResearchReference>[0])).toThrow();
  expect(owner.project(result.receipt)).toEqual(['Ordinary source.']);
});

test.each([
  { revision: 'stale', spans: [] }, { spans: [{ part: 0, start: 0, end: 100 }] },
  { spans: [{ part: 0, start: 0, end: 5 }, { part: 0, start: 4, end: 8 },
    ],
  },
  { spans: [{ part: 0, start: 0, end: 1.5 }] }, { spans: [{ part: 8, start: 0, end: 1 }] },
  { spans: [], replacement: 'invented' },
])('bad proposal is withheld before Jev or projection: %j', async (proposal) => {
  const f = fixture({ propose: (source) => ({ revision: source.revision, ...proposal }) });
  expect((await f.owner.screen(f.owner.capture(['Original text.']))).status).toBe('held'); expect(f.calls).toHaveLength(1);
});

test('complete structural privacy preflight runs before clipping, hashing or route calls', () => {
  const f = fixture(); let reads = 0;
  const getter = Object.defineProperty([], '0', { get() { reads++; return 'private'; },
  }); getter.length = 1;
  for (const input of [getter, ['apiKey=private-fixture'], ['ordinary '.repeat(6_000), 'password=private-fixture'], ['ghp_' + 'X'.repeat(40)],
  ]) expect(() => f.owner.capture(input)).toThrow();
  expect(reads).toBe(0); expect(f.calls).toHaveLength(0);
});

test('sparse and proxy sources refuse before any descriptor trap or request', () => {
  const f = fixture(); let traps = 0;
  const proxy = new Proxy(['ordinary'], { getOwnPropertyDescriptor() { traps++; throw new Error('private'); }, ownKeys() { traps++; throw new Error('private'); }, getPrototypeOf() { traps++; throw new Error('private'); },
  });
  expect(() => f.owner.capture(proxy)).toThrow(); expect(() => f.owner.capture([proxy] as unknown as string[])).toThrow();
  expect(() => f.owner.capture(new Array<string>(2))).toThrow(); expect(traps).toBe(0); expect(f.calls).toHaveLength(0);
});

test('proposal identity is local bookkeeping independent of source content', async () => {
  const f = fixture({ propose: (source) => {
    expect(source.revision).toMatch(/^source-[1-9][0-9]*$/);
    return { revision: source.revision, spans: [] };
  },
  });
  expect((await projected(f.owner, ['Ordinary build note 222.'])).parts).toEqual(['Ordinary build note 222.']); expect(f.calls).toHaveLength(2);
});

test('releasing settled source A is independent of unrelated pending source B', async () => {
  const gate = deferred<void>(), started = deferred<void>();
  const f = fixture({ propose: async (source) => {
    if (source.parts[0] === 'Second source.') { started.resolve(); await gate.promise; }
    return { revision: source.revision, spans: [] };
  },
  });
  const a = f.owner.capture(['First source.']), b = f.owner.capture(['Second source.']);
  expect((await f.owner.screen(a)).status).toBe('settled'); const pendingB = f.owner.screen(b); await started.promise;
  try { await f.owner.release(a); expect(await f.owner.screen(a)).toEqual({ status: 'held', reason: 'stale' }); }
  finally { gate.resolve(); await pendingB; }
});

test('revocation between local proposal and judgment withholds and emits no late verification', async () => {
  let allowed = true;
  const f = fixture({ authority: () => { if (!allowed) throw new Error('private-revocation-reason'); }, propose: (source) => { allowed = false; return { revision: source.revision, spans: [] }; },
  });
  expect(await f.owner.screen(f.owner.capture(['Ordinary text.']))).toEqual({ status: 'held', reason: 'stale' }); expect(f.calls).toHaveLength(1);
});

test('an unavailable protected local decision halts and an explicit retry retains the source', async () => {
  let retries = 0;
  const f = fixture({ onRetry: () => { retries++; }, judge: (body, count) => (count === 1 ? new Response('private service echo', { status: 503 }) : reading(body, 1, 1)),
  });
  const source = f.owner.capture(['Ordinary text.']);
  expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'route-unavailable' });
  const result = await f.owner.screen(source);
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') throw new Error('Expected explicit retry to settle');
  expect(f.owner.project(result.receipt)).toEqual(['Ordinary text.']);
  expect(retries).toBe(0); expect(f.calls.filter((call) => call.path === '/v1/systemone')).toHaveLength(2);
}, 10_000);

test('Preferred private screening falls back locally after its authorized decision route is exhausted', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture({ judge: () => new Response('', { status: 503 }) });
    const first = await projected(f.owner, ['Ordinary build notes.']);
    expect(first.parts).toEqual(['Ordinary build notes.']);
    expect(first.receipt).toMatchObject({ provenance: 'classic' });
    expect(decisionModelPolicyState()).toMatchObject({ policy: 'Preferred', operation: 'classic', reason: 'unavailable' });
    const sends = f.calls.length;
    const second = await projected(f.owner, ['Another ordinary build note.']);
    expect(second.receipt).toMatchObject({ provenance: 'classic' });
    expect(f.calls).toHaveLength(sends);
    expect(f.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
  });
});

test('Preferred private screening cannot replace a semantic refusal with local approval', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture({ judge: body => reading(body, 0, 1) });
    const source = f.owner.capture(['Ordinary build notes.']);
    expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'unsettled' });
    expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'unsettled' });
    expect(decisionModelPolicyState().operation).toBe('decision');
    expect(f.calls).toHaveLength(2);
  });
});

test('Preferred malformed private decision responses remain held without Classic fallback', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture({ judge: () => Response.json({ answers: 'malformed' }) });
    expect(await f.owner.screen(f.owner.capture(['Ordinary build notes.']))).toEqual({ status: 'held', reason: 'malformed' });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic private screening makes no proposal or decision requests from owner creation onward', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const f = fixture();
    const result = await projected(f.owner, ['Ordinary build notes.']);
    expect(result.parts).toEqual(['Ordinary build notes.']);
    expect(result.receipt).toMatchObject({ provenance: 'classic' });
    expect(f.calls).toHaveLength(0);
    expect(() => f.owner.capture(['password=synthetic-private-value'])).toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

test('cancellation interrupts a pending protected decision even when its provider ignores cancellation', async () => {
  const entered = deferred<void>(),
    held = deferred<Response>();
  const f = fixture({ judge: async () => {
      entered.resolve();
      return held.promise;
    },
  });
  const pending = f.owner.screen(f.owner.capture(['Ordinary text.'])); await entered.promise;
  try {
    const closing = f.owner.close(); expect(f.owner.close()).toBe(closing); await closing;
  expect(await pending).toEqual({ status: 'held', reason: 'cancelled' });
  expect(() => f.owner.capture(['late'])).toThrow(); expect(f.calls).toHaveLength(2);
  } finally {
    held.resolve(new Response('private', { status: 503 }));
  }
}, 10_000);

test('different model response is malformed and never a semantic result', async () => {
  const f = fixture({ judge: (body, count) => reading(body, 1, 1, count === 1 ? 'jev-9.0.0' : 'jev-1.13.0') });
  const source = f.owner.capture(['Ordinary text.']);
  expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'malformed' });
  expect((await f.owner.screen(source)).status).toBe('settled');
});

test('synchronous authority failures never expose borrowed exception data', async () => {
  let allowed = true;
  const f = fixture({ authority: () => { if (!allowed) throw new Error('synthetic-private-authority-marker'); },
  });
  const settled = await projected(f.owner, ['Ordinary source.']); allowed = false;
  for (const call of [() => f.owner.capture(['New source.']), () => f.owner.project(settled.receipt), () => createProtectedSourceOwner(f.config),
  ]) {
    try { call(); throw new Error('Expected refusal'); }
    catch (error) { expect(String(error)).toBe('Error: Protected source owner is unavailable or the handle is not current'); }
  }
});

test('a single unavailable target cannot trigger a retry observer or an automatic second send', async () => {
  let observed = 0;
  const f = fixture({ judge: () => new Response('', { status: 503 }),
    onRetry: async () => {
      observed++;
      throw new Error('synthetic-observer-private-marker'); },
  });
  expect(await f.owner.screen(f.owner.capture(['Ordinary source.']))).toEqual({ status: 'held', reason: 'route-unavailable' });
  expect(observed).toBe(0); expect(f.calls).toHaveLength(2);
}, 10_000);

test('real protected mapper feeds Slack adapter, persisted inbox and wire projection without raw content', async () => {
  const f = fixture({ propose: (source) => ({ revision: source.revision, spans: [{ part: 1, start: 5, end: 24 }, { part: 3, start: 5, end: 24 },
      ],
    }),
  });
  const mapper = createProtectedInboxMapper(f.owner), dir = makeProjectTempDir('protected-source-inbox');
  const catalog = new GatewayMethodCatalog(), logs: unknown[] = [];
  const logger = { info: (...args: unknown[]) => { logs.push(args); }, warn: (...args: unknown[]) => { logs.push(args); }, error: (...args: unknown[]) => { logs.push(args); },
  };
  const ts = `${Math.floor((Date.now() - 1_000) / 1_000)}.000000`;
  const adapter = createSlackInboxAdapter(
    { logger, credentials: { resolveRef: async () => null, resolveConfigSecret: async () => 'xoxb-synthetic-fixture' } },
    {
      mapItem: mapper,
      http: async (url) => ({
        ok: true,
        body: url.pathname.endsWith('auth.test')
          ? { ok: true, user_id: 'UOWNER' }
          : url.pathname.endsWith('conversations.list')
            ? { ok: true, channels: [{ id: 'DTEST' }] }
            : { ok: true, messages: [{ ts, user: 'USENDER', text: 'Call person@example.test, keep the build notes.' }] },
      }),
    },
  );
  const ctx = { catalog, logger, workingDirectory: dir };
  const surface = registerInboxSurface(ctx, { adapters: new Map([['slack', adapter]]) });
  try {
    await surface.ready;
    const wire = await catalog.invoke('channels.inbox.list', { body: {}, context: {} });
    expect(wire).toMatchObject({
      total: 1,
      items: [{ from: digestSender('USENDER'), bodyPreview: 'Call [redacted], keep the build notes.' }],
    });
    expect(JSON.stringify(wire)).not.toContain('person@example.test');
    expect(JSON.stringify(logs)).not.toContain('person@example.test');
  } finally {
    await surface.close();
  }
  expect((await readFile(new InboxCursorStore(dir).dbPath)).toString()).not.toContain('person@example.test');
  const reopened = registerInboxSurface(ctx, { adapters: new Map([['slack', adapter]]), skipInitialPoll: true });
  try {
    await reopened.ready;
    expect(await catalog.invoke('channels.inbox.list', { body: {}, context: {} })).toMatchObject({
      total: 1,
      items: [{ bodyPreview: 'Call [redacted], keep the build notes.' }],
    });
    expect(f.calls).toHaveLength(2);
  } finally {
    await reopened.close();
  }
});

test('mapper screens the full original and normalized candidate before display clipping', async () => {
  const f = fixture(),
    mapper = createProtectedInboxMapper(f.owner),
    text = '<p>' + 'ordinary '.repeat(80) + '</p>';
  const mapped = await mapper({ senderId: 'USENDER', channelId: 'DTEST', subject: 'Direct message', text });
  expect(mapped?.bodyPreview).toHaveLength(500);
  expect(mapped?.bodyPreview).not.toContain('<p>');
  expect(f.calls[1]!.body['state']).toMatchObject({ parts: ['Direct message', text, 'Direct message', 'ordinary '.repeat(80).trim()] });
});

test('numeric provider identifiers stay local protocol data while identical raw text stays protected', async () => {
  const identifier = '1556818270617600003'; // Synthetic 2026-10-06 Discord snowflake, sequence 3.
  const f = fixture(),
    mapper = createProtectedInboxMapper(f.owner);
  expect(await mapper({ senderId: identifier, channelId: identifier, subject: 'Direct message', text: 'Ordinary build note.' })).toEqual({
    fromDigest: digestSender(identifier),
    subjectPreview: 'Direct message',
    bodyPreview: 'Ordinary build note.',
  });
  expect(f.calls).toHaveLength(2);
  expect(JSON.stringify(f.calls)).not.toContain(identifier);
  const before = f.calls.length;
  expect(await mapper({ senderId: 'USENDER', channelId: 'DTEST', subject: 'Direct message', text: identifier })).toBeNull();
  expect(f.calls).toHaveLength(before);
});

test('releasing and recapturing an unchanged uncertain source cannot retry for a lucky answer', async () => {
  const f = fixture({ judge: (body, count) => reading(body, count === 1 ? 0.5 : 1, 1) }),
    mapper = createProtectedInboxMapper(f.owner);
  const original = { senderId: 'USENDER', channelId: 'DTEST', subject: 'Direct message', text: 'Ordinary unchanged source.' };
  expect(await mapper(original)).toBeNull();
  expect(await mapper({ ...original })).toBeNull();
  expect(f.calls).toHaveLength(2);
  expect(await mapper({ ...original, text: 'A genuinely changed source.' })).toMatchObject({ bodyPreview: 'A genuinely changed source.' });
  expect(f.calls).toHaveLength(4);
});

test('active source retention has an explicit bound and release restores capacity', async () => {
  const f = fixture(),
    handles = Array.from({ length: 128 }, () => f.owner.capture(['Ordinary source.']));
  expect(() => f.owner.capture(['One more.'])).toThrow();
  expect(f.calls).toHaveLength(0);
  await f.owner.release(handles[0]!);
  expect(f.owner.capture(['Capacity recovered.'])).toBeDefined();
});

test('distinct handles cannot concurrently sample the same uncertain revision', async () => {
  const gate = deferred<void>(),
    started = deferred<void>();
  const f = fixture({
    propose: async (source) => {
      started.resolve();
      await gate.promise;
      return { revision: source.revision, spans: [] };
    },
    judge: (body, count) => reading(body, count === 1 ? 0.5 : 1, 1),
  });
  const a = f.owner.capture(['Same immutable source.']),
    b = f.owner.capture(['Same immutable source.']);
  const first = f.owner.screen(a);
  await started.promise;
  try {
    expect(await Promise.race([f.owner.screen(b), Promise.resolve('still-pending')])).toEqual({ status: 'held', reason: 'busy' });
    expect(f.calls).toHaveLength(1);
  } finally {
    gate.resolve();
    await first;
  }
  expect(await f.owner.screen(b)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(f.calls).toHaveLength(2);
});

test('ordinary successful screening and projection create no refusal commitment', async () => {
  const f = fixture(), hashes = spyOn(crypto, 'createHash');
  try {
    const source = f.owner.capture(['An ordinary exact source.']);
    const result = await f.owner.screen(source);
    expect(result.status).toBe('settled');
    if (result.status !== 'settled') throw new Error('Expected settled fixture');
    for (let guard = 0; guard < 10; guard++) {
      expect(f.owner.project(result.receipt)).toEqual(['An ordinary exact source.']);
      expect(await f.owner.screen(source)).toBe(result);
    }
    await f.owner.release(source);
    expect(hashes).not.toHaveBeenCalled();
  } finally { hashes.mockRestore(); }
});

test('same-length pending sources compare exact original parts without hashing or sampling duplicates', async () => {
  const gate = deferred<void>(), started = deferred<void>(); let count = 0;
  const f = fixture({ propose: async source => {
    if (++count === 2) started.resolve();
    await gate.promise; return { revision: source.revision, spans: [] };
  } });
  const hashes = spyOn(crypto, 'createHash');
  const first = f.owner.screen(f.owner.capture(['Source A.']));
  const second = f.owner.screen(f.owner.capture(['Source B.']));
  try {
    await started.promise;
    expect(await f.owner.screen(f.owner.capture(['Source A.']))).toEqual({ status: 'held', reason: 'busy' });
    expect(f.calls).toHaveLength(2);
    gate.resolve();
    expect((await first).status).toBe('settled'); expect((await second).status).toBe('settled');
    expect(hashes).not.toHaveBeenCalled();
  } finally { gate.resolve(); await Promise.allSettled([first, second]); hashes.mockRestore(); }
});

test('an actual unsettled commitment survives raw handle release and is computed only once per original', async () => {
  const f = fixture({ judge: body => reading(body, 0.5, 1) });
  const hashes = spyOn(crypto, 'createHash');
  try {
    const source = f.owner.capture(['The same uncertain original.']);
    expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'unsettled' });
    expect(hashes).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 10; attempt++) expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'unsettled' });
    expect(hashes).toHaveBeenCalledTimes(1);
    await f.owner.release(source);
    const calls = f.calls.length;
    const recaptured = f.owner.capture(['The same uncertain original.']);
    expect(await f.owner.screen(recaptured)).toEqual({ status: 'held', reason: 'unsettled' });
    expect(f.calls).toHaveLength(calls); expect(hashes).toHaveBeenCalledTimes(2);
  } finally { hashes.mockRestore(); }
});

test('released refused input cannot borrow Preferred Classic fallback established by a different source', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture({ judge: (body, count) => count === 1 ? reading(body, 0.5, 1) : new Response('', { status: 503 }) });
    const original = f.owner.capture(['Originally unsettled input.']);
    expect(await f.owner.screen(original)).toEqual({ status: 'held', reason: 'unsettled' });
    await f.owner.release(original);
    expect((await f.owner.screen(f.owner.capture(['Different ordinary source.']))).status).toBe('settled');
    expect(decisionModelPolicyState().operation).toBe('classic');
    const calls = f.calls.length;
    expect(await f.owner.screen(f.owner.capture(['Originally unsettled input.']))).toEqual({ status: 'held', reason: 'unsettled' });
    expect(f.calls).toHaveLength(calls);
  });
});

test('unsettled capacity never evicts an earlier hold or sends overflowing work', async () => {
  const f = fixture({ judge: (body) => reading(body, 0.5, 1) });
  for (let index = 0; index < 1_024; index++) {
    const source = f.owner.capture([`Ordinary held source ${index}.`]);
    const result = await f.owner.screen(source);
    if (result.status !== 'held' || result.reason !== 'unsettled') throw new Error('Expected a synthetic unsettled reading');
    await f.owner.release(source);
  }
  const calls = f.calls.length;
  expect(calls).toBe(2_048);
  expect(await f.owner.screen(f.owner.capture(['New source exceeds hold capacity.']))).toEqual({ status: 'held', reason: 'capacity' });
  expect(await f.owner.screen(f.owner.capture(['Ordinary held source 0.']))).toEqual({ status: 'held', reason: 'unsettled' });
  expect(f.calls).toHaveLength(calls);
}, 60_000);

test('malformed proposal releases its reservation without manufacturing a semantic hold', async () => {
  let proposals = 0;
  const f = fixture({
    propose: (source) => ({ revision: source.revision, spans: ++proposals === 1 ? [{ part: 0, start: 0, end: 99_999 }] : [] }),
  });
  const source = f.owner.capture(['Same original.']);
  expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'malformed' });
  expect((await f.owner.screen(source)).status).toBe('settled');
  expect(f.calls).toHaveLength(3);
});

test('new uncertainty retires older positive receipts for the same exact source revision', async () => {
  const f = fixture({ judge: (body, count) => reading(body, count === 1 ? 1 : 0.5, 1) });
  const a = f.owner.capture(['Same immutable original.']);
  const first = await f.owner.screen(a);
  expect(first.status).toBe('settled');
  if (first.status !== 'settled') return;
  expect(f.owner.project(first.receipt)).toEqual(['Same immutable original.']);
  const b = f.owner.capture(['Same immutable original.']);
  expect(await f.owner.screen(b)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(await f.owner.screen(a)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(() => f.owner.project(first.receipt)).toThrow();
  await f.owner.release(b);
  expect(() => f.owner.project(first.receipt)).toThrow();
  expect(f.calls).toHaveLength(4);
});

test('ordinary screening retains per-call fences through actual proposal and verification', async () => {
  const f = fixture(),
    lifetime = new AbortController();
  let guards = 0;
  const handle = f.owner.capture(['Ordinary guarded build note.']);
  try {
    const result = await f.owner.screen(handle, {
      signal: lifetime.signal,
      assertCurrent: () => {
        guards++;
      },
    });
    expect(result.status).toBe('settled');
    expect(guards).toBeGreaterThan(2);
    if (result.status === 'settled') expect(f.owner.project(result.receipt)).toEqual(['Ordinary guarded build note.']);
    expect(f.calls.map((call) => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
  } finally {
    await f.owner.release(handle);
  }
});

test.each(['caller', 'source'] as const)('ordinary proposal retirement of %s emits no verification request', async (kind) => {
  const started = deferred<void>(),
    gate = deferred<void>();
  let allowed = true;
  const f = fixture({
    propose: async (source) => {
      started.resolve();
      await gate.promise;
      return { revision: source.revision, spans: [] };
    },
  });
  const handle = f.owner.capture(['Ordinary held proposal.']);
  const pending = f.owner.screen(handle, {
    assertCurrent: () => {
      if (!allowed) throw new Error('Caller retired');
    },
  });
  let releasing: Promise<void> | undefined;
  try {
    await started.promise;
    if (kind === 'caller') allowed = false;
    else releasing = f.owner.release(handle);
    gate.resolve();
    expect(await pending).toEqual({ status: 'held', reason: kind === 'source' ? 'cancelled' : 'stale' });
    expect(f.calls.map((call) => call.path)).toEqual(['/v1/chat/completions']);
  } finally {
    gate.resolve();
    await Promise.allSettled([pending, releasing, f.owner.release(handle)]);
  }
});

test('ordinary caller abort during proposal drains without a verification request', async () => {
  const started = deferred<void>(),
    gate = deferred<void>(),
    lifetime = new AbortController();
  const f = fixture({
    propose: async (source) => {
      started.resolve();
      await gate.promise;
      return { revision: source.revision, spans: [] };
    },
  });
  const handle = f.owner.capture(['Ordinary cancellable proposal.']);
  const pending = f.owner.screen(handle, { signal: lifetime.signal });
  try {
    await started.promise;
    lifetime.abort();
    gate.resolve();
    expect(await pending).toEqual({ status: 'held', reason: 'cancelled' });
    expect(f.calls.map((call) => call.path)).toEqual(['/v1/chat/completions']);
  } finally {
    gate.resolve();
    await Promise.allSettled([pending, f.owner.release(handle)]);
  }
});

test('ordinary per-call restrictions reject accessors and nonvoid callbacks before routing', async () => {
  const f = fixture();
  let reads = 0;
  const handle = f.owner.capture(['Ordinary restricted source.']);
  try {
    const accessor = Object.defineProperty({}, 'assertCurrent', {
      get() {
        reads++;
        return () => {};
      },
    });
    expect(await f.owner.screen(handle, accessor)).toEqual({ status: 'held', reason: 'malformed' });
    expect(reads).toBe(0);
    expect(await f.owner.screen(handle, { assertCurrent: () => true })).toEqual({ status: 'held', reason: 'stale' });
    expect(await f.owner.screen(handle, { assertCurrent: () => Promise.reject(new Error('Private refusal')) })).toEqual({
      status: 'held',
      reason: 'stale',
    });
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.owner.release(handle);
  }
});
