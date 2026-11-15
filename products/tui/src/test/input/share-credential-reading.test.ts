import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConversationManager } from '../../core/conversation.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerShareRuntimeCommands } from '../../input/commands/share-runtime.ts';
import { getSharedNotificationFeed } from '../../views/notifications-feed.ts';
import { CommandReadings } from '../../input/commands/command-readings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
const originalFetch = globalThis.fetch;
afterEach(() => { installJudgmentPort(previous); globalThis.fetch = originalFetch; getSharedNotificationFeed().clear(); });
function fixture() {
  const root = makeProjectTempDir('gv-share-reading');
  const lines: string[] = [];
  const registry = new CommandRegistry(); registerShareRuntimeCommands(registry);
  const calls: string[] = [];
  const conversation = new ConversationManager();
  conversation.title = 'Test export';
  conversation.addUserMessage('hello');
  const authHeaders = { Authorization: 'Bearer configured-literal' };
  let lookup: (() => Promise<void>) | undefined;
  const runtime = { model: 'synthetic-unpriced', provider: 'synthetic', sessionId: 'exact-session' };
  const readings = new CommandReadings(() => runtime.sessionId, () => true);
  const lifetime = { cancel: () => readings.cancel('share'), dispose: () => readings.dispose() };
  const context = {
    commandReadings: readings,
    print: (text: string) => lines.push(text),
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    platform: { serviceRegistry: { resolveAuth: async (name: string) => { calls.push(name); const wait = lookup; lookup = undefined; await wait?.(); return authHeaders; } } },
    session: { runtime, conversationManager: conversation },
  } as unknown as CommandContext;
  return { root, lines, calls, runtime, lifetime, authHeaders, holdNextLookup: (wait: () => Promise<void>) => { lookup = wait; }, replace: () => conversation.fromJSON({ messages: [{ role: 'user', content: 'hello' }] }), run: (args = ['json', 'session.json', '--upload', '--no-redact', '--yes']) => registry.get('share')!.handler(args, context) };
}

test('share sends the configured bearer token with no model reading and repeats normally', async () => {
  const f = fixture();
  const fake = fakePort(() => noulAnswer(0.99)); previous = installJudgmentPort(fake.port);
  const headers: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, options?: RequestInit) => {
    headers.push(new Headers(options?.headers).get('Authorization')!);
    return Response.json({ html_url: 'https://gist.github.com/synthetic' });
  }) as unknown as typeof fetch;
  await f.run(); await f.run();
  expect(headers).toEqual(['Bearer configured-literal', 'Bearer configured-literal']);
  expect(f.calls).toEqual(['github', 'github', 'github', 'github']);
  expect(fake.requests).toHaveLength(0);
  expect(f.lines.filter(line => line.includes('Share link:'))).toHaveLength(2);
  expect(readFileSync(join(f.root, 'session.json'), 'utf8')).toContain('hello');
});

test('a replaced history cancels asynchronous export redaction before disk or stale error publication', async () => {
  const f = fixture(); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fixturePort = fakePort((name, question) => question.type === 'choice'
    ? choiceAnswer(question, 'other', 0.99) : noulAnswer(name === 'identifying' ? 0.99 : 0.01));
  previous = installJudgmentPort({ ...fixturePort.port, async ask(request) { entered.resolve(); await release.promise; return fixturePort.port.ask(request); } });
  const pending = f.run(['json', 'session.json', '--redact']);
  await entered.promise;
  const before = [...f.lines]; f.replace();
  await pending;
  expect(f.lines).toEqual(before);
  expect(existsSync(join(f.root, 'session.json'))).toBe(false);
  expect(f.calls).toEqual([]);
  release.resolve();
});

test('a service entry without a bearer token uploads nothing and says how to fix it', async () => {
  const f = fixture(); let uploads = 0;
  globalThis.fetch = (async () => { uploads++; return Response.json({ html_url: 'https://gist.github.com/synthetic' }); }) as unknown as typeof fetch;
  const fake = fakePort(() => noulAnswer(0.99)); previous = installJudgmentPort(fake.port);
  const savedEnv = process.env['GITHUB_TOKEN']; delete process.env['GITHUB_TOKEN'];
  try {
    delete (f.authHeaders as Record<string, string>)['Authorization'];
    (f.authHeaders as Record<string, string>)['X-API-Key'] = 'not-a-bearer';
    await f.run();
  } finally {
    if (savedEnv !== undefined) process.env['GITHUB_TOKEN'] = savedEnv;
  }
  expect(uploads).toBe(0);
  expect(fake.requests).toHaveLength(0);
  expect(f.lines.some(line => line.startsWith('No GitHub token found for --upload.'))).toBe(true);
  expect(f.lines.some(line => line.startsWith('Exported JSON session'))).toBe(true);
});

for (const change of ['escape', 'session', 'exit', 'conversation'] as const) {
  test(`pending share cannot upload after ${change}`, async () => {
    const f = fixture(); let uploads = 0;
    globalThis.fetch = (async () => { uploads++; return Response.json({ html_url: 'https://gist.github.com/synthetic' }); }) as unknown as typeof fetch;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
    previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    f.holdNextLookup(async () => { requested(); await gate; });
    const pending = f.run(); await started;
    if (change === 'escape') f.lifetime.cancel();
    if (change === 'exit') f.lifetime.dispose();
    if (change === 'session') f.runtime.sessionId = 'other-session';
    if (change === 'conversation') f.replace();
    release(); await pending;
    expect(uploads).toBe(0);
    expect(readdirSync(f.root).filter(name => name.includes('.gist-'))).toEqual([]);
    expect(f.lines.some(line => line.includes('Share link:'))).toBe(false);
  });
}

test('repeated pending share makes one upload', async () => {
  const f = fixture(); let uploads = 0;
  globalThis.fetch = (async () => { uploads++; return Response.json({ html_url: 'https://gist.github.com/synthetic' }); }) as unknown as typeof fetch;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  f.holdNextLookup(async () => { requested(); await gate; });
  const pending = f.run(); await started;
  await f.run(); release(); await pending;
  expect(uploads).toBe(1);
});

for (const outcome of ['accepted', 'unconfirmed'] as const) {
  test(`revoked upload preserves ${outcome} receipt under original session without stale UI`, async () => {
    const f = fixture();
    previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let dispatched!: () => void; const started = new Promise<void>(resolve => { dispatched = resolve; });
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++; dispatched(); await gate;
      if (outcome === 'unconfirmed') throw new Error('connection ended before reply');
      return Response.json({ html_url: 'https://gist.github.com/accepted-before-cancel' });
    }) as unknown as typeof fetch;
    const pending = f.run(); await started;
    f.lifetime.cancel(); f.runtime.sessionId = 'replacement-session';
    const priorLines = [...f.lines]; release(); await pending;
    expect(requests).toBe(1); expect(f.lines).toEqual(priorLines);
    const receipts = readdirSync(f.root).filter(name => name.startsWith('session.json.gist-'));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(f.root, receipts[0]!), 'utf8'));
    expect(receipt.status).toBe(outcome); expect(receipt.sessionId).toBe('exact-session');
    if (outcome === 'accepted') expect(receipt.url).toBe('https://gist.github.com/accepted-before-cancel');
    else expect(receipt.url).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('configured-literal');
  });
}


test('accepted result survives receipt write failure as source-labelled notification, never stale chat or retry', async () => {
  const f = fixture(); previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++; f.lifetime.cancel(); f.runtime.sessionId = 'replacement-session';
    rmSync(f.root, { recursive: true, force: true }); writeFileSync(f.root, 'blocks receipt directory');
    return Response.json({ html_url: 'https://gist.github.com/accepted-without-durable-receipt' });
  }) as unknown as typeof fetch;
  await f.run();
  expect(requests).toBe(1);
  expect(f.lines.some(line => line.includes('Share link:'))).toBe(false);
  const notice = getSharedNotificationFeed().list().find(entry => entry.domain === 'share');
  expect(notice?.title).toBe('Gist accepted for session exact-session; receipt not saved');
  expect(notice?.body).toBe('https://gist.github.com/accepted-without-durable-receipt');
});
