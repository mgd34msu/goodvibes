// Proves: The same provider message id sent to two sessions is two messages, and a redelivery to one session is one, also after a restart.
// Red when: The replay key leaves out the session (the second session's message is dropped) or a redelivery after a restart is recorded twice.
// Proves: After a conversation's session is closed by the idle timer or the owner, every later message on that chat is refused and dropped.
// Red when: handleSharedSessionIntent stops reopening a system-closed session or rolling over an owner-closed one.
/**
 * A caller that addresses sessions by id numbers its messages per session, so
 * the same message id sent to two sessions is two messages: each session
 * records its own. A redelivery of one message to the same session is still
 * recorded once, also after the daemon restarts. A chat whose session was
 * closed keeps taking messages: one the idle sweep closed is reopened with its
 * transcript, one the owner closed is followed by a new session.
 *
 * Real session broker over its store file and real route bindings; a restart
 * is a second broker over the same files.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setSystemTime();
});

async function broker(root: string): Promise<SharedSessionBroker> {
  const opened = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'),
    routeBindings: new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) }),
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  });
  await opened.start();
  return opened;
}

const send = (into: SharedSessionBroker, sessionId: string, body: string) => into.submitMessage({
  sessionId, surfaceKind: 'webhook', surfaceId: 'caller', externalId: 'caller-1', providerMessageId: 'msg-1', body,
});

/** How many user messages in the session carry this body. */
const recorded = (from: SharedSessionBroker, sessionId: string, body: string) =>
  from.getMessages(sessionId, 1_000).filter((message) => message.role === 'user' && message.body === body).length;

test('the same message id sent to two sessions is recorded in both, and a redelivery to one is recorded once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-session-intent-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const first = await broker(root);
  let firstOpen = true;
  cleanups.push(async () => { if (firstOpen) await first.stop(); });

  const a = await first.createSession({ title: 'A' });
  const b = await first.createSession({ title: 'B' });
  const toA = await send(first, a.id, 'question for A');
  const toB = await send(first, b.id, 'question for B');

  expect(toB.session.id).toBe(b.id);
  expect(toB.userMessage.id).not.toBe(toA.userMessage.id);
  expect(recorded(first, a.id, 'question for A')).toBe(1);
  expect(recorded(first, b.id, 'question for B')).toBe(1);
  expect(first.getInputs(b.id).length).toBe(1);

  // The provider retries the message to A: it is the same message.
  const again = await send(first, a.id, 'question for A');
  expect(again.userMessage.id).toBe(toA.userMessage.id);
  expect(recorded(first, a.id, 'question for A')).toBe(1);

  await first.stop();
  firstOpen = false;
  const second = await broker(root);
  cleanups.push(() => second.stop());
  await send(second, a.id, 'question for A');
  await send(second, b.id, 'question for B');
  expect(recorded(second, a.id, 'question for A')).toBe(1);
  expect(recorded(second, b.id, 'question for B')).toBe(1);
  expect(recorded(second, b.id, 'question for A')).toBe(0);
});

test('a chat whose session the idle sweep closed is reopened by its next message, and one the owner closed moves to a new session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-session-closed-route-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const opened = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  await opened.start();
  cleanups.push(() => opened.stop());
  const route = await routeBindings.upsertBinding({ kind: 'channel', surfaceKind: 'telegram', surfaceId: 'telegram', externalId: 'chat-1', channelId: 'chat-1' });
  const fromChat = (n: number) => opened.submitMessage({
    routeId: route.id, surfaceKind: 'telegram', surfaceId: 'telegram', externalId: 'chat-1', userId: 'owner-1', body: `message ${n}`, providerMessageId: `tg-${n}`,
  });

  const first = await fromChat(1);
  const session = first.session.id;
  // The agent answers the first message; the conversation then goes quiet.
  await opened.bindAgent(session, 'agent-1', first.input!.id);
  await opened.completeAgent(session, 'agent-1', 'answer 1');
  // A day of silence, then the idle sweep runs (the clock is the stand-in).
  setSystemTime(new Date(Date.now() + 26 * 60 * 60 * 1000));
  (opened as unknown as { gcSweep(): void }).gcSweep();
  expect(opened.getSession(session)?.status).toBe('closed');

  const afterSweep = await fromChat(2);
  expect(afterSweep.session.id).toBe(session);
  expect(opened.getSession(session)?.status).toBe('active');
  expect(opened.getMessages(session, 100).filter((message) => message.role === 'user').map((message) => message.body)).toEqual(['message 1', 'message 2']);

  await opened.closeSession(session);
  const afterOwnerClose = await fromChat(3);
  expect(afterOwnerClose.session.id).not.toBe(session);
  expect(afterOwnerClose.mode).not.toBe('rejected');
  expect(opened.getSession(session)?.status).toBe('closed');
  expect(routeBindings.getBinding(route.id)?.sessionId).toBe(afterOwnerClose.session.id);
  expect(opened.getMessages(afterOwnerClose.session.id, 100).filter((message) => message.role === 'user').map((message) => message.body)).toEqual(['message 3']);
});
