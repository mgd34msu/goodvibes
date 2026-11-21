// Proves: An agent's answer to a channel message is sent twice, or not at all, when the daemon restarts between storing it and sending it.
// Red when: A repeated report after a restart sends the answer again, or an answer stored but not sent when the daemon stopped is never sent or is sent on every start.
// Proves: One rate limit on the send loses the answer on the channel, a send cut off after it arrived is posted twice, or a retry repeats the parts of a long answer that already arrived.
// Red when: channelSendKnowledge counts a 429 as a possibly-arrived send, or a reset after arrival as safe to repeat on ntfy, or deliverFinalExclusive resends delivered parts.
/**
 * An agent's answer to a channel message reaches the channel once, also when
 * the daemon restarts after sending it and the surface that ran the agent
 * reports the same answer again because it never heard back. An answer whose
 * report first arrives after the restart is still delivered, and so is one the
 * daemon had stored but not yet sent when it stopped.
 *
 * Real pieces: the session broker and route bindings over their files, the
 * settings manager, secret store and service registry, the reply pipeline,
 * the daemon's surface-delivery helper and its ntfy sender. The agent
 * runtime, where the model begins, reports no running agent. For the restart
 * cases the ntfy plugin's reply goes to the helper's ntfy sender, where a stop
 * inside the send can be stood in; for the rate-limit case it is wired as the
 * daemon wires the built-in one, rendered through the channel delivery router
 * to its ntfy strategy. The ntfy server is a loopback server that records
 * every message it receives. A restart is a second set of these objects over
 * the same files, with the process's ntfy repeat memory cleared as a new
 * process starts without it. A rate limit is the ntfy server refusing a
 * request with 429; a send cut off after it arrived is the server recording
 * the message and resetting the connection; the pipeline's wait before a
 * retry (the clock) resolves at once.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { ChannelReplyPipeline } from '../platform/src/platform/channels/reply-pipeline.ts';
import { ChannelPluginRegistry } from '../platform/src/platform/channels/plugin-registry.ts';
import { DaemonSurfaceDeliveryHelper } from '../platform/src/platform/daemon/surface-delivery.ts';
import { ServiceRegistry } from '../platform/src/platform/config/service-registry.ts';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.ts';
import { isSurfaceDeliveryEnabled } from '../platform/src/platform/daemon/surface-policy.ts';
import { isSurfaceFeatureGateEnabled } from '../platform/src/platform/runtime/feature-flags/gates.ts';
import { scratchSettings } from './_helpers/scratch-settings.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { ntfyOutboundDedup } from '../platform/src/platform/integrations/ntfy.ts';
import type { PendingSurfaceReply } from '../platform/src/platform/daemon/types.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ChannelDeliveryRouter } from '../platform/src/platform/channels/delivery-router.ts';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.ts';
import { renderBuiltinChannelEvent } from '../platform/src/platform/channels/builtin/rendering.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  ntfyOutboundDedup.reset();
});

/**
 * The ntfy server: every message it accepted, by topic. `refuse` answers 429 to
 * the requests it picks, which are not received. `cutOff` picks topics whose
 * message is received and whose connection is then reset with no answer.
 */
async function ntfyServer(
  refuse: (request: number, body: string) => boolean = () => false,
  cutOff: (topic: string) => boolean = () => false,
): Promise<{ readonly url: string; readonly received: Array<{ topic: string; body: string }> }> {
  const received: Array<{ topic: string; body: string }> = [];
  let requests = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      if (refuse(++requests, body)) { res.writeHead(429, { 'retry-after': '1' }).end('{"error":"limit reached"}'); return; }
      const topic = decodeURIComponent((req.url ?? '/').slice(1));
      received.push({ topic, body });
      if (cutOff(topic)) { req.socket.destroy(); return; }
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/**
 * One daemon's delivery pieces over the home's files. With `dies`, the process
 * stops inside its first channel send: the send never reaches the server and
 * never returns, as when the daemon is killed there; `dies` is called on arrival.
 */
async function daemon(root: string, options: { readonly dies?: () => void; readonly viaRouter?: boolean } = {}) {
  // The daemon's settings and secret store over the home's files; no ntfy credential is stored.
  const { configManager, secretsManager } = await scratchSettings({}, root);
  const serviceRegistry = new ServiceRegistry({ user: join(root, 'home', 'services.json'), project: join(root, 'project', 'services.json') },
    { secretsManager, subscriptionManager: new SubscriptionManager(join(root, 'home', 'subscriptions.json'), { secrets: secretsManager }) });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  await sessionBroker.start();
  const channelPlugins = new ChannelPluginRegistry();
  const channelReplyPipeline = new ChannelReplyPipeline({ channelPlugins, routeBindings, waitBeforeRetry: async () => undefined });
  const helper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: new Map<string, PendingSurfaceReply>(),
    channelReplyPipeline, configManager, routeBindings, sessionBroker, channelPlugins, secretsManager, serviceRegistry,
    // The agent runtime, where the model begins: no agent is running.
    agentManager: { getStatus: () => null },
    authToken: () => null,
    // As the facade decides it, with no feature-flag manager.
    surfaceDeliveryEnabled: (surface: Parameters<typeof isSurfaceDeliveryEnabled>[1]) => isSurfaceFeatureGateEnabled(null, surface) && isSurfaceDeliveryEnabled(configManager, surface),
  } as unknown as ConstructorParameters<typeof DaemonSurfaceDeliveryHelper>[0]);
  if (options.viaRouter) {
    // As the built-in ntfy plugin is registered in the daemon: its reply is rendered
    // through the channel delivery router to the ntfy strategy.
    const deliveryRouter = new ChannelDeliveryRouter({ configManager, serviceRegistry, secretsManager, routeBindings, artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }) });
    const rendering = { deps: { deliveryRouter, routeBindings } } as unknown as Parameters<typeof renderBuiltinChannelEvent>[0];
    channelPlugins.register({
      id: 'surface:ntfy', surface: 'ntfy', displayName: 'ntfy', capabilities: ['egress'],
      renderEvent: (request) => renderBuiltinChannelEvent(rendering, 'ntfy', request),
    } as Parameters<ChannelPluginRegistry['register']>[0]);
    return {
      configManager, routeBindings, sessionBroker, helper,
      async stop() { channelReplyPipeline.dispose(); await sessionBroker.stop(); },
    };
  }
  // The reply through the helper's ntfy sender, where a stop inside the send can be stood in.
  channelPlugins.register({
    id: 'surface:ntfy', surface: 'ntfy', displayName: 'ntfy', capabilities: ['egress'],
    deliverReply: (pending, message) => {
      if (options.dies) { options.dies(); return new Promise<void>(() => {}); }
      return helper.deliverNtfyAgentReply(pending as PendingSurfaceReply, message);
    },
  } as Parameters<ChannelPluginRegistry['register']>[0]);
  return {
    configManager, routeBindings, sessionBroker, helper,
    async stop() { channelReplyPipeline.dispose(); await sessionBroker.stop(); },
  };
}

type Daemon = Awaited<ReturnType<typeof daemon>>;

/** A message from an ntfy topic that an agent was started to answer. */
async function conversation(d: Daemon, topic: string, agentId: string): Promise<string> {
  const binding = await d.routeBindings.upsertBinding({ kind: 'channel', surfaceKind: 'ntfy', surfaceId: 'ntfy', externalId: topic, channelId: topic });
  const submitted = await d.sessionBroker.submitMessage({
    routeId: binding.id, surfaceKind: 'ntfy', surfaceId: 'ntfy', externalId: topic, body: `a question on ${topic}`, providerMessageId: `${topic}-1`,
  });
  await d.sessionBroker.bindAgent(submitted.session.id, agentId, submitted.input!.id);
  expect(d.helper.queueSurfaceReplyFromBinding(d.routeBindings.getBinding(binding.id), { agentId, task: `a question on ${topic}`, sessionId: submitted.session.id })).toBe(true);
  return submitted.session.id;
}

test('an answer is sent once across a restart, and one first reported after the restart is still sent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-delivery-once-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ntfy = await ntfyServer();
  const first = await daemon(root);
  let firstRunning = true;
  cleanups.push(async () => { if (firstRunning) await first.stop(); });
  first.configManager.setMany([{ key: 'surfaces.ntfy.enabled' as ConfigKey, value: true }, { key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], localOwnerActor());

  const answered = await conversation(first, 'topic-answered', 'agent-answered');
  const later = await conversation(first, 'topic-later', 'agent-later');

  // The surface running the agent reports its answer; it is stored and sent.
  await first.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-answered', sessionId: answered, body: 'the first answer' });
  expect(ntfy.received.filter((entry) => entry.topic === 'topic-answered').map((entry) => entry.body)).toEqual(['the first answer']);

  // The daemon stops before the surface heard back.
  await first.stop();
  firstRunning = false;
  ntfyOutboundDedup.reset();
  const second = await daemon(root);
  cleanups.push(() => second.stop());

  // The surface reports the same answer again: it is not sent a second time.
  await second.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-answered', sessionId: answered, body: 'the first answer' });
  expect(ntfy.received.filter((entry) => entry.topic === 'topic-answered')).toHaveLength(1);
  expect(second.sessionBroker.getMessages(answered, 1_000).filter((message) => message.body === 'the first answer')).toHaveLength(1);

  // The other agent finishes only now: its answer still reaches its conversation, once.
  await second.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-later', sessionId: later, body: 'the later answer' });
  await second.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-later', sessionId: later, body: 'the later answer' });
  expect(ntfy.received.filter((entry) => entry.topic === 'topic-later').map((entry) => entry.body)).toEqual(['the later answer']);
});

test('an answer stored but not yet sent when the daemon stopped is sent after the restart, once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-delivery-owed-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ntfy = await ntfyServer();
  let reachedSend!: () => void;
  const sending = new Promise<void>((resolve) => { reachedSend = resolve; });
  const first = await daemon(root, { dies: () => reachedSend() });
  let firstRunning = true;
  cleanups.push(async () => { if (firstRunning) await first.stop(); });
  first.configManager.setMany([{ key: 'surfaces.ntfy.enabled' as ConfigKey, value: true }, { key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], localOwnerActor());
  const session = await conversation(first, 'topic-owed', 'agent-owed');

  // The answer is stored, then the daemon stops inside the send.
  void first.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-owed', sessionId: session, body: 'the owed answer' });
  // Settled when the send is entered, however long the store takes on a loaded machine.
  await sending;
  expect(ntfy.received).toHaveLength(0);
  await first.stop();
  firstRunning = false;
  ntfyOutboundDedup.reset();

  const second = await daemon(root);
  cleanups.push(() => second.stop());
  // The surface never heard back and reports again: the answer reaches the channel, once.
  await second.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-owed', sessionId: session, body: 'the owed answer' });
  await second.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-owed', sessionId: session, body: 'the owed answer' });
  expect(ntfy.received.map((entry) => entry.body)).toEqual(['the owed answer']);
  expect(second.sessionBroker.getMessages(session, 1_000).filter((message) => message.body === 'the owed answer')).toHaveLength(1);
  await second.stop();

  // A third start after the send: a repeated report sends nothing.
  ntfyOutboundDedup.reset();
  const third = await daemon(root);
  cleanups.push(() => third.stop());
  await third.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-owed', sessionId: session, body: 'the owed answer' });
  expect(ntfy.received).toHaveLength(1);
});

test('an answer a closed conversation still owed when 3.3.4 stopped is sent once by the first start of this release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-delivery-upgrade-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ntfy = await ntfyServer();
  let reachedSend!: () => void;
  const sending = new Promise<void>((resolve) => { reachedSend = resolve; });
  const first = await daemon(root, { dies: () => reachedSend() });
  let firstRunning = true;
  cleanups.push(async () => { if (firstRunning) await first.stop(); });
  first.configManager.setMany([{ key: 'surfaces.ntfy.enabled' as ConfigKey, value: true }, { key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], localOwnerActor());
  const session = await conversation(first, 'topic-upgrade', 'agent-upgrade');

  // The answer is stored, the conversation is closed, and the daemon stops inside the send.
  void first.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-upgrade', sessionId: session, body: 'the upgrade answer' });
  await sending;
  await first.sessionBroker.closeSession(session);
  await first.stop();
  firstRunning = false;
  ntfyOutboundDedup.reset();

  // The index as 3.3.4 wrote it: the logs say what is owed, the index states no count.
  const indexPath = join(root, 'sessions.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { owedReplyCounted?: unknown; sessions: Array<Record<string, unknown>> };
  expect(index.sessions.find((entry) => entry['id'] === session)?.['status']).not.toBe('active');
  delete index.owedReplyCounted;
  for (const entry of index.sessions) delete entry['owedReplyCount'];
  writeFileSync(indexPath, JSON.stringify(index));

  // The first start of this release sends what was owed, once.
  const second = await daemon(root);
  cleanups.push(() => second.stop());
  await second.helper.resendOwedChannelReplies();
  await second.helper.resendOwedChannelReplies();
  expect(ntfy.received.filter((entry) => entry.topic === 'topic-upgrade' && entry.body.startsWith('the upgrade answer'))).toHaveLength(1);
});

test('an answer refused once by a rate limit still arrives once, one cut off after it arrived is not sent again, and a retried part of a long answer does not repeat the part already sent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-delivery-retry-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const first = 'A'.repeat(1_200);
  const second = 'B'.repeat(1_200);
  // The first request of all, and the first request carrying the second part, are rate limited.
  let secondPartRefused = false;
  const ntfy = await ntfyServer((request, body) => {
    if (request === 1) return true;
    if (body.includes('BBBB') && !secondPartRefused) { secondPartRefused = true; return true; }
    return false;
  }, (topic) => topic === 'topic-cut');
  // The reply path the daemon takes: the built-in plugin's rendering through the delivery router.
  const d = await daemon(root, { viaRouter: true });
  cleanups.push(() => d.stop());
  d.configManager.setMany([{ key: 'surfaces.ntfy.enabled' as ConfigKey, value: true }, { key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], localOwnerActor());

  const short = await conversation(d, 'topic-short', 'agent-short');
  await d.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-short', sessionId: short, body: 'a short answer' });
  expect(ntfy.received.filter((entry) => entry.topic === 'topic-short').map((entry) => entry.body)).toEqual(['a short answer']);

  // ntfy cannot drop a repeat: an answer that arrived and whose connection was then
  // reset may have been posted, so it is reported undelivered and not sent again.
  const cut = await conversation(d, 'topic-cut', 'agent-cut');
  await d.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-cut', sessionId: cut, body: 'the cut-off answer' }).catch(() => undefined);
  expect(ntfy.received.filter((entry) => entry.topic === 'topic-cut').map((entry) => entry.body)).toEqual(['the cut-off answer']);

  const long = await conversation(d, 'topic-long', 'agent-long');
  await d.helper.completeSurfaceReplyFromSurface({ agentId: 'agent-long', sessionId: long, body: `${first}\n\n${second}` });
  const parts = ntfy.received.filter((entry) => entry.topic === 'topic-long').map((entry) => entry.body);
  expect(secondPartRefused).toBe(true);
  // Two messages arrived, each part once, in order.
  const which = (body: string) => (body.includes('AAAA') ? (body.includes('BBBB') ? 'both' : 'first part') : body.includes('BBBB') ? 'second part' : 'other');
  expect(parts.map(which)).toEqual(['first part', 'second part']);
});
