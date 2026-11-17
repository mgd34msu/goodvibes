// Proves: An agent's answer to a channel message is sent twice, or not at all, when the daemon restarts between storing it and sending it.
// Red when: A repeated report after a restart sends the answer again, or an answer stored but not sent when the daemon stopped is never sent or is sent on every start.
/**
 * An agent's answer to a channel message reaches the channel once, also when
 * the daemon restarts after sending it and the surface that ran the agent
 * reports the same answer again because it never heard back. An answer whose
 * report first arrives after the restart is still delivered, and so is one the
 * daemon had stored but not yet sent when it stopped.
 *
 * Real pieces: the session broker and route bindings over their files, the
 * settings manager, the reply pipeline, the daemon's surface-delivery helper
 * and its ntfy sender. The ntfy channel plugin is wired as the built-in one is
 * (its reply goes to the helper's ntfy sender); the ntfy server is a loopback
 * server that records every message it receives. A restart is a second set of
 * these objects over the same files, with the process's ntfy repeat memory
 * cleared as a new process starts without it.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { ntfyOutboundDedup } from '../platform/src/platform/integrations/ntfy.ts';
import type { PendingSurfaceReply } from '../platform/src/platform/daemon/types.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  ntfyOutboundDedup.reset();
});

/** The ntfy server: every message it received, by topic. */
async function ntfyServer(): Promise<{ readonly url: string; readonly received: Array<{ topic: string; body: string }> }> {
  const received: Array<{ topic: string; body: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => { received.push({ topic: decodeURIComponent((req.url ?? '/').slice(1)), body }); res.writeHead(200).end('{}'); });
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
async function daemon(root: string, options: { readonly dies?: () => void } = {}) {
  const configManager = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  await sessionBroker.start();
  const channelPlugins = new ChannelPluginRegistry();
  const channelReplyPipeline = new ChannelReplyPipeline({ channelPlugins, routeBindings });
  const helper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: new Map<string, PendingSurfaceReply>(),
    channelReplyPipeline, configManager, routeBindings, sessionBroker, channelPlugins,
    secretsManager: { get: async () => null, getGlobalHome: () => null },
    // No ntfy credential is registered.
    serviceRegistry: { resolveSecret: async () => null },
    agentManager: { getStatus: () => null },
    authToken: () => null,
    surfaceDeliveryEnabled: () => true,
  } as unknown as ConstructorParameters<typeof DaemonSurfaceDeliveryHelper>[0]);
  // As the built-in ntfy plugin is registered: its reply goes to the helper's ntfy sender.
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
  first.configManager.setMany([{ key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], { kind: 'owner', surface: 'fixture' });

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
  first.configManager.setMany([{ key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], { kind: 'owner', surface: 'fixture' });
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
