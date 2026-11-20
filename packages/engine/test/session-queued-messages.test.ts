// Proves: A message accepted while its session or the whole fleet was busy is never started, also after a restart.
// Red when: completeAgent stops starting the queued follow-up, or load forgets the rows waiting for capacity.
/**
 * A message the daemon accepted while its conversation's agent was still
 * running waits in the session and is started when that agent ends; one that
 * could not start because every agent slot was taken waits for a free slot,
 * and still does after a restart.
 *
 * Real session broker and route bindings over their files; a restart is a
 * second broker over the same files. The agent fleet is the stand-in: the
 * continuation runner records what it was asked to start.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import type { SharedSessionContinuationRequest } from '../platform/src/platform/control-plane/session-intents.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function open(root: string) {
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const broker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  await broker.start();
  return { broker, routeBindings };
}

/** A conversation on a webhook route whose first message an agent is answering. */
async function busyConversation(d: Awaited<ReturnType<typeof open>>, name: string) {
  const route = await d.routeBindings.upsertBinding({ kind: 'channel', surfaceKind: 'webhook', surfaceId: 'webhook', externalId: name, channelId: name });
  const message = { routeId: route.id, surfaceKind: 'webhook', surfaceId: 'webhook', externalId: name } as const;
  const first = await d.broker.submitMessage({ ...message, body: `${name}: first`, providerMessageId: `${name}-1` });
  await d.broker.bindAgent(first.session.id, `${name}-agent-1`, first.input!.id);
  /** A follow-up the caller sends while the agent is still answering. */
  const send = (body: string, id: string) => d.broker.followUpMessage({ ...message, body, providerMessageId: id });
  return { session: first.session.id, send };
}

const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-queued-messages-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a message that arrived while its conversation\'s agent ran is started when that agent ends, once', async () => {
  const d = await open(scratch());
  cleanups.push(() => d.broker.stop());
  const started: string[] = [];
  d.broker.setContinuationRunner((request: SharedSessionContinuationRequest) => { started.push(request.input.body); return { agentId: `agent-${started.length + 1}` }; });
  const chat = await busyConversation(d, 'chat-a');

  const second = await chat.send('chat-a: second', 'chat-a-2');
  expect(second.input?.state).toBe('queued');
  expect(started).toEqual([]);

  await d.broker.completeAgent(chat.session, 'chat-a-agent-1', 'the first answer');
  // The same end reported again starts nothing more.
  await d.broker.completeAgent(chat.session, 'chat-a-agent-1', 'the first answer');
  expect(started).toEqual(['chat-a: second']);
});

test('messages waiting for a free agent slot are started once, in arrival order, by the daemon after a restart', async () => {
  const root = scratch();
  const before = await open(root);
  let beforeOpen = true;
  cleanups.push(async () => { if (beforeOpen) await before.broker.stop(); });
  // Every agent slot is taken.
  before.broker.setContinuationRunner(() => ({ disposition: 'capacity', reason: 'every agent slot is taken' }));
  const one = await busyConversation(before, 'chat-1');
  const two = await busyConversation(before, 'chat-2');
  const waitingOne = await one.send('chat-1: waits', 'chat-1-2');
  const waitingTwo = await two.send('chat-2: waits', 'chat-2-2');
  await before.broker.completeAgent(one.session, 'chat-1-agent-1', 'answer');
  await before.broker.completeAgent(two.session, 'chat-2-agent-1', 'answer');
  const state = (broker: SharedSessionBroker, session: string, inputId: string) => broker.getInputs(session).find((row) => row.id === inputId)?.state;
  expect([state(before.broker, one.session, waitingOne.input!.id), state(before.broker, two.session, waitingTwo.input!.id)]).toEqual(['queued', 'queued']);

  // The daemon stops with both still waiting; a new one opens the same files.
  before.broker.setContinuationRunner(null);
  await before.broker.stop();
  beforeOpen = false;
  const after = await open(root);
  cleanups.push(() => after.broker.stop());
  const started: string[] = [];
  after.broker.setContinuationRunner((request: SharedSessionContinuationRequest) => { started.push(request.input.body); return { agentId: `restarted-agent-${started.length}` }; });
  await after.broker.idle();

  expect(started).toEqual(['chat-1: waits', 'chat-2: waits']);
  expect([state(after.broker, one.session, waitingOne.input!.id), state(after.broker, two.session, waitingTwo.input!.id)]).toEqual(['spawned', 'spawned']);
});
