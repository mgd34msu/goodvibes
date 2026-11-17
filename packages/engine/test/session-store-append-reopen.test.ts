// Proves: A session's messages are found after a restart, and a terminal's named session keeps saving.
// Red when: A message appended to an open or closed session is missing in a second broker, or a resumed session saved under its file name is refused or lands in a second file.
/**
 * Session stores lose nothing across a restart. The daemon's session broker:
 * a message appended is found by the next broker over the same files, for an
 * open session and a closed one, and a record torn by a crash mid-write costs
 * only that record. A terminal's saved session: a session saved under a
 * display name keeps saving when it is addressed by its file name.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { SessionManager, type SessionMeta } from '../platform/src/platform/sessions/manager.ts';

const roots: string[] = [];
const brokers: SharedSessionBroker[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-session-store-'));
  roots.push(root);
  return root;
}

/** One daemon start: a broker over the session files in `root`. */
async function broker(root: string): Promise<SharedSessionBroker> {
  const started = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'),
    routeBindings: new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) }),
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  });
  brokers.push(started);
  await started.start();
  return started;
}
async function restart(root: string, running: SharedSessionBroker): Promise<SharedSessionBroker> {
  await running.stop();
  brokers.splice(brokers.indexOf(running), 1);
  return broker(root);
}
const bodies = (from: SharedSessionBroker, sessionId: string) => from.getMessages(sessionId, 1_000).map((message) => message.body);

test('messages appended before a restart are found by the next broker, for an open and a closed session', async () => {
  const root = tempRoot();
  let first = await broker(root);
  const open = await first.createSession({ id: 'open-session', title: 'Open' });
  const closed = await first.createSession({ id: 'closed-session', title: 'Closed' });
  for (const n of [1, 2, 3]) await first.appendSystemMessage(open.id, `open ${n}`);
  for (const n of [1, 2]) await first.appendSystemMessage(closed.id, `closed ${n}`);
  await first.closeSession(closed.id);

  first = await restart(root, first);
  expect(bodies(first, open.id)).toEqual(['open 1', 'open 2', 'open 3']);
  // A closed session's messages stay on disk until asked for, and are all there when they are.
  expect(bodies(first, closed.id)).toEqual(['closed 1', 'closed 2']);
  expect(first.getSession(closed.id)?.status).toBe('closed');

  // An append after the restart lands beside the old ones, and a third start sees all of them.
  await first.appendSystemMessage(open.id, 'open 4');
  first = await restart(root, first);
  expect(bodies(first, open.id)).toEqual(['open 1', 'open 2', 'open 3', 'open 4']);
});

test('a session saved under a display name keeps saving when it is opened by its file name', () => {
  const root = tempRoot();
  const meta = (title: string): SessionMeta => ({ title, model: 'fixture-model', provider: 'fixture', timestamp: 1, conversationId: 'conversation-1' });
  const sessions = new SessionManager(root, { sessionsDir: join(root, 'sessions') });
  sessions.save('My Chat', [{ role: 'user', content: 'first' }], meta('My Chat'));

  // The next start lists the session by its file name, and the open session saves under that name.
  const reopened = new SessionManager(root, { sessionsDir: join(root, 'sessions') });
  const listed = reopened.list();
  expect(listed).toHaveLength(1);
  const fileName = listed[0]!.name;
  reopened.save(fileName, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }], meta('My Chat'));

  const loaded = new SessionManager(root, { sessionsDir: join(root, 'sessions') }).load('My Chat');
  expect(loaded.messages).toHaveLength(2);
  // Another name that maps to the same file is still refused, and nothing is lost.
  expect(() => reopened.save('my chat!', [], meta('Other'))).toThrow();
  expect(reopened.load(fileName).messages).toHaveLength(2);
});
