/**
 * companion-chat-route-hardening.test.ts
 *
 * What a caller of the companion chat routes is told and trusted with: the
 * per-client message cap is reachable through HTTP, only the daemon's own
 * authority has its messages attested as the owner's, internal failures do not
 * leak storage paths, and an unusable saved chat is set aside and reported.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionLLMProvider, CompanionProviderChunk } from '../platform/src/platform/companion/companion-chat-manager.js';
import { dispatchCompanionChatRoutes } from '../platform/src/platform/companion/companion-chat-routes.js';
import type { CompanionChatRouteContext } from '../platform/src/platform/companion/companion-chat-route-types.js';
import { CompanionChatPersistence } from '../platform/src/platform/companion/companion-chat-persistence.js';
import { logger } from '../platform/src/platform/utils/logger.js';
import { awaitCompanionReply } from '../platform/src/platform/companion/companion-chat-turn-control.js';

const provider: CompanionLLMProvider = {
  async *chatStream() {
    yield { type: 'text_delta', delta: 'ok' } satisfies CompanionProviderChunk;
    yield { type: 'done' } satisfies CompanionProviderChunk;
  },
};

const managers: CompanionChatManager[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeManager(rateLimiter: { perClientLimit: number; perSessionLimit: number }): CompanionChatManager {
  const manager = new CompanionChatManager({
    provider,
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999,
    persist: false,
    rateLimiter,
  });
  managers.push(manager);
  return manager;
}

function context(chatManager: CompanionChatManager, extra: Partial<CompanionChatRouteContext> = {}): CompanionChatRouteContext {
  return {
    chatManager,
    async parseJsonBody(req) { return await req.json() as { [k: string]: unknown }; },
    async parseOptionalJsonBody(req) {
      const text = await req.text();
      return text ? JSON.parse(text) as { [k: string]: unknown } : null;
    },
    openSessionEventStream: () => new Response('', { status: 200 }),
    ...extra,
  };
}

function post(path: string, body: unknown, token: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('companion chat per-client message cap', () => {
  test('one credential posting to many sessions is stopped by the client cap, and another credential is not', async () => {
    const manager = makeManager({ perClientLimit: 3, perSessionLimit: 10 });
    const ctx = context(manager);
    const sessions = [1, 2, 3, 4, 5].map(() => manager.createSession({ provider: 'p', model: 'm' }).id);

    const statuses: number[] = [];
    let refusal: { code?: string } = {};
    for (const id of sessions.slice(0, 4)) {
      const res = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages`, { body: 'hi' }, 'token-a'), ctx);
      statuses.push(res!.status);
      if (res!.status !== 202) refusal = await res!.json() as { code?: string };
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect(refusal.code).toBe('COMPANION_CHAT_CLIENT_RATE_LIMIT');

    const other = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${sessions[4]}/messages`, { body: 'hi' }, 'token-b'), ctx);
    expect(other!.status).toBe(202);
  });
});

describe('companion chat per-client cap on regenerate and edit', () => {
  test.each(['retry', 'edit'] as const)('one credential using %s across many sessions is stopped by the client cap', async action => {
    const manager = makeManager({ perClientLimit: 3, perSessionLimit: 10 });
    const ctx = context(manager);
    const sessions = [1, 2, 3, 4, 5].map(() => manager.createSession({ provider: 'p', model: 'm' }).id);
    const body = action === 'edit' ? { messageId: 'missing', content: 'x' } : {};

    // The sessions hold no messages, so each call is refused for that reason; the cap counts the attempt first.
    const codes: unknown[] = [];
    for (const id of sessions.slice(0, 4)) {
      const res = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages/${action}`, body, 'token-a'), ctx);
      codes.push(((await res!.json()) as { code?: string }).code);
    }
    expect(codes.slice(0, 3).every(code => code !== 'COMPANION_CHAT_CLIENT_RATE_LIMIT')).toBe(true);
    expect(codes[3]).toBe('COMPANION_CHAT_CLIENT_RATE_LIMIT');

    const other = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${sessions[4]}/messages/${action}`, body, 'token-b'), ctx);
    expect(((await other!.json()) as { code?: string }).code).not.toBe('COMPANION_CHAT_CLIENT_RATE_LIMIT');
  });
});

describe('companion chat owner attestation', () => {
  function recordOwnerDirect(manager: CompanionChatManager): boolean[] {
    const seen: boolean[] = [];
    const original = manager.postMessage.bind(manager);
    manager.postMessage = ((sessionId: string, content: string, clientId?: string, options?: { ownerDirect?: boolean }) => {
      seen.push(options?.ownerDirect === true);
      return original(sessionId, content, clientId, options);
    }) as typeof manager.postMessage;
    return seen;
  }

  test('a caller without admin authority is not attested as the owner, an admin is', async () => {
    const manager = makeManager({ perClientLimit: 30, perSessionLimit: 10 });
    const seen = recordOwnerDirect(manager);
    const id = manager.createSession({ provider: 'p', model: 'm' }).id;
    const refuse = () => new Response('forbidden', { status: 403 });

    const nonAdmin = await dispatchCompanionChatRoutes(
      post(`/api/companion/chat/sessions/${id}/messages`, { body: 'hello' }, 'user-token'),
      context(manager, { requireAdmin: refuse }),
    );
    expect(nonAdmin!.status).toBe(202);

    const admin = await dispatchCompanionChatRoutes(
      post(`/api/companion/chat/sessions/${id}/messages`, { body: 'hello again' }, 'admin-token'),
      context(manager, { requireAdmin: () => null }),
    );
    expect(admin!.status).toBe(202);
    expect(seen).toEqual([false, true]);
  });
});

describe('companion chat edit attestation and attachments', () => {
  test('an edit is attested as the owner for an admin only, and a regenerate never is', async () => {
    const manager = makeManager({ perClientLimit: 30, perSessionLimit: 10 });
    const id = manager.createSession({ provider: 'p', model: 'm' }).id;
    const seen: Array<boolean | undefined> = [];
    manager.editMessage = ((_sessionId: string, _input: unknown, options?: { ownerDirect?: boolean }) => {
      seen.push(options?.ownerDirect);
      return { sessionId: id, editedFrom: 'm1', messageId: 'm2', supersededMessageIds: [], turnStarted: true };
    }) as typeof manager.editMessage;
    manager.regenerateMessage = ((_sessionId: string, _input: unknown, options?: { ownerDirect?: boolean }) => {
      seen.push(options?.ownerDirect);
      return { sessionId: id, regeneratedFrom: 'm1', supersededMessageIds: [], turnStarted: true };
    }) as typeof manager.regenerateMessage;
    const refuse = () => new Response('forbidden', { status: 403 });

    await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages/edit`, { messageId: 'm1', body: 'x' }, 't'), context(manager, { requireAdmin: () => null }));
    await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages/edit`, { messageId: 'm1', body: 'x' }, 't'), context(manager, { requireAdmin: refuse }));
    await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages/retry`, {}, 't'), context(manager, { requireAdmin: () => null }));
    expect(seen).toEqual([true, false, undefined]);
  });

  test('a message that attaches an artifact needs read:artifacts, one without attachments does not', async () => {
    const manager = makeManager({ perClientLimit: 30, perSessionLimit: 10 });
    const id = manager.createSession({ provider: 'p', model: 'm' }).id;
    const asked: string[] = [];
    const requireScope = (_req: Request, scope: string) => {
      asked.push(scope);
      return Response.json({ error: `Missing required scope for this request: ${scope}` }, { status: 403 });
    };
    const ctx = context(manager, { requireScope });
    const attachment = [{ artifactId: 'art-1' }];

    for (const route of ['messages', 'messages/steer']) {
      const res = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/${route}`, { body: 'see this', attachments: attachment }, 't'), ctx);
      expect(res!.status).toBe(403);
    }
    // A missing session answers the same refusal, so attaching cannot probe which sessions exist.
    const edit = await dispatchCompanionChatRoutes(post('/api/companion/chat/sessions/missing/messages/edit', { messageId: 'm1', body: 'x', attachments: attachment }, 't'), ctx);
    expect(edit!.status).toBe(403);
    expect(asked).toEqual(['read:artifacts', 'read:artifacts', 'read:artifacts']);

    const plain = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages`, { body: 'no attachment' }, 't'), ctx);
    expect(plain!.status).toBe(202);
    expect(asked).toHaveLength(3);
  });
});

describe('companion chat error responses', () => {
  test('an unexpected failure is answered with a fixed message, not the path in its text', async () => {
    const manager = makeManager({ perClientLimit: 30, perSessionLimit: 10 });
    const id = manager.createSession({ provider: 'p', model: 'm' }).id;
    manager.postMessage = (async () => { throw new Error("EACCES: permission denied, open '/home/owner/.goodvibes/companion-chat/sessions/x.json'"); }) as typeof manager.postMessage;
    const res = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages`, { body: 'hi' }, 't'), context(manager));
    expect(res!.status).toBe(500);
    const text = await res!.text();
    expect(text).not.toContain('/home/owner');
    expect(JSON.parse(text).code).toBe('INTERNAL_ERROR');
  });

  test('a storage failure keeps its code and 503 but not the path from the save error', async () => {
    const manager = makeManager({ perClientLimit: 30, perSessionLimit: 10 });
    const id = manager.createSession({ provider: 'p', model: 'm' }).id;
    manager.postMessage = (async () => {
      throw Object.assign(new Error('Saving this chat failed (ENOSPC: /var/lib/goodvibes/chats/x.json)'), { code: 'CHAT_PERSISTENCE_UNAVAILABLE', status: 503 });
    }) as typeof manager.postMessage;
    const res = await dispatchCompanionChatRoutes(post(`/api/companion/chat/sessions/${id}/messages`, { body: 'hi' }, 't'), context(manager));
    expect(res!.status).toBe(503);
    const text = await res!.text();
    expect(text).not.toContain('/var/lib');
    expect(JSON.parse(text).code).toBe('CHAT_PERSISTENCE_UNAVAILABLE');
  });

  test('a deliberate client error keeps its own message and status', async () => {
    const manager = makeManager({ perClientLimit: 30, perSessionLimit: 10 });
    const res = await dispatchCompanionChatRoutes(post('/api/companion/chat/sessions/missing/messages', { body: 'hi' }, 't'), context(manager));
    expect(res!.status).toBe(404);
    expect((await res!.json() as { code: string }).code).toBe('SESSION_NOT_FOUND');
  });
});

describe('saved chat files that cannot be loaded', () => {
  test('a file with the wrong shape is reported and set aside, not left to be overwritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-chat-reject-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ meta: { id: 'bad' }, messages: {} }));
    writeFileSync(join(dir, 'torn.json'), '{"meta":');

    const store = new CompanionChatPersistence(dir);
    const loaded = await store.loadAll();

    expect(loaded).toEqual([]);
    const rejected = store.rejectedOnLoad();
    expect(rejected.map((entry) => entry.file).sort()).toEqual(['bad.json', 'torn.json']);
    expect(rejected.every((entry) => entry.reason.length > 0 && entry.movedTo !== undefined)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(existsSync(join(dir, 'bad.json.rejected'))).toBe(true);
  });

  test('a well-formed chat under another file name is reported but left where it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-chat-name-'));
    dirs.push(dir);
    const file = join(dir, 'copy.json');
    writeFileSync(file, JSON.stringify({ meta: { id: 'real-id' }, messages: [] }));
    const store = new CompanionChatPersistence(dir);
    expect(await store.loadAll()).toEqual([]);
    expect(store.rejectedOnLoad()).toEqual([{ file: 'copy.json', reason: 'file name does not match the chat id inside it' }]);
    expect(existsSync(file)).toBe(true);
  });
});

describe('companion chat startup with set-aside saved chats', () => {
  test('init says how many chats were set aside and which files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-chat-init-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'torn.json'), '{"meta":');
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const manager = new CompanionChatManager({
        provider, eventPublisher: { publishEvent() {} }, gcIntervalMs: 999_999, persist: true, sessionsDir: dir,
      });
      managers.push(manager);
      await manager.init();
      const call = warn.mock.calls.find(([message]) => String(message).startsWith('[companion-chat] saved chats could not be loaded'));
      expect(call).toBeDefined();
      const detail = call![1] as { rejected: number; rejectedFiles: string[] };
      expect(detail.rejected).toBe(1);
      expect(detail.rejectedFiles[0]).toContain('torn.json');
    } finally { warn.mockRestore(); }
  });
});

describe('a reply wait whose deadline passes while the post is in flight', () => {
  test('the registration is dropped once the post reports its id', async () => {
    let finishPost: (id: string) => void = () => {};
    const dropped: string[] = [];
    const result = await awaitCompanionReply(
      1,
      () => new Promise<string>((resolve) => { finishPost = resolve; }),
      (id) => { dropped.push(id); },
    );
    expect(result.timedOut).toBe(true);
    expect(dropped).toEqual([]);

    finishPost('late-message');
    await Promise.resolve();
    await Promise.resolve();
    expect(dropped).toEqual(['late-message']);
  });
});

describe('companion chat clientMessageId over HTTP', () => {
  test('a resent request gets the first message id, and an unusable id is a 400 that sends nothing', async () => {
    const manager = makeManager({ perClientLimit: 30, perSessionLimit: 10 });
    const ctx = context(manager);
    const id = manager.createSession({ provider: 'p', model: 'm' }).id;
    const path = `/api/companion/chat/sessions/${id}/messages`;

    const first = await (await dispatchCompanionChatRoutes(post(path, { body: 'hi', clientMessageId: 'local-1' }, 't'), ctx))!.json() as { messageId: string };
    const resent = await (await dispatchCompanionChatRoutes(post(path, { body: 'hi', clientMessageId: 'local-1' }, 't'), ctx))!.json() as { messageId: string };
    expect(resent.messageId).toBe(first.messageId);

    for (const bad of ['', '   ', 'x'.repeat(129), 7]) {
      const refused = await dispatchCompanionChatRoutes(post(path, { body: 'hi', clientMessageId: bad }, 't'), ctx);
      expect(refused!.status).toBe(400);
    }
    expect(manager.getMessages(id).filter((message) => message.role === 'user')).toHaveLength(1);
  });
});
