/**
 * A caller that addresses sessions by id numbers its messages per session, so
 * the same message id sent to two sessions is two messages: each session
 * records its own. A redelivery of one message to the same session is still
 * recorded once, also after the daemon restarts.
 *
 * Real session broker over its store file and real route bindings; a restart
 * is a second broker over the same files.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

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
