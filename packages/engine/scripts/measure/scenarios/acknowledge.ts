/**
 * The paths that tell a person or a client "accepted", "sent" or "answered":
 * a web chat send, a channel answer reported by the surface that ran the
 * agent, a scheduled run's settle and delivery, and an approval raised and
 * answered. Each store sits at the path the product composition gives it under
 * the isolated home; the far side of every send is a loopback server in this
 * process that records what arrived.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CompanionChatManager } from '../../../platform/src/platform/companion/companion-chat-manager.ts';
import { defaultSessionsDir } from '../../../platform/src/platform/companion/companion-chat-persistence.ts';
import type { CompanionLLMProvider } from '../../../platform/src/platform/companion/companion-chat-turn-control.ts';
import { SharedSessionBroker } from '../../../platform/src/platform/control-plane/session-broker.ts';
import { controlPlaneStorePath } from '../../../platform/src/platform/control-plane/control-plane-store-paths.ts';
import { ApprovalBroker } from '../../../platform/src/platform/control-plane/approval-broker.ts';
import { RouteBindingManager } from '../../../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../../../platform/src/platform/automation/store/routes.ts';
import { ChannelReplyPipeline } from '../../../platform/src/platform/channels/reply-pipeline.ts';
import { ChannelPluginRegistry } from '../../../platform/src/platform/channels/plugin-registry.ts';
import { DaemonSurfaceDeliveryHelper } from '../../../platform/src/platform/daemon/surface-delivery.ts';
import type { PendingSurfaceReply } from '../../../platform/src/platform/daemon/types.ts';
import { AutomationDeliveryManager } from '../../../platform/src/platform/automation/delivery-manager.ts';
import { AutomationManager } from '../../../platform/src/platform/automation/manager-runtime.ts';
import { ArtifactStore } from '../../../platform/src/platform/artifacts/index.ts';
import { ConfigManager } from '../../../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../../../platform/src/platform/config/schema.ts';
import { SecretsManager } from '../../../platform/src/platform/config/secrets.ts';
import { ServiceRegistry } from '../../../platform/src/platform/config/service-registry.ts';
import { SubscriptionManager } from '../../../platform/src/platform/config/subscriptions.ts';
import { ntfyOutboundDedup } from '../../../platform/src/platform/integrations/ntfy.ts';
import { createShellPathService } from '../../../platform/src/platform/runtime/shell-paths.ts';
import type { AgentRecord } from '../../../platform/src/platform/tools/agent/record.ts';
import { allowFixturePort } from '../instrument.ts';
import { decisions } from './stores.ts';
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';
import { localOwnerActor } from '../../../daemon-api/src/actor.ts';

const P = 'packages/engine/platform/src/platform';

/** Event-loop turns until `done` holds; bounded in turns, never in milliseconds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 200_000; turn += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assertOutcome(done(), `gave up waiting for ${what}`);
}

/** The far side of a send: an ntfy server on loopback that records every message by topic. */
async function recorder(): Promise<{ readonly url: string; readonly received: Array<{ topic: string; body: string }>; close(): Promise<void> }> {
  const received: Array<{ topic: string; body: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      received.push({ topic: decodeURIComponent((req.url ?? '/').slice(1)), body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  allowFixturePort(port);
  return {
    url: `http://127.0.0.1:${port}`, received,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** The settings the daemon composes (daemon/boot.ts): it owns the daemon tier, where surface settings are kept. */
function daemonConfig(env: MeasureEnv): ConfigManager {
  return new ConfigManager({ surfaceRoot: 'goodvibes', homeDir: env.home, workingDir: env.workspace, ownsDaemonTier: true });
}

function sessionBroker(env: MeasureEnv, routeBindings: RouteBindingManager): SharedSessionBroker {
  const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
  return new SharedSessionBroker({
    storePath: controlPlaneStorePath(shellPaths, 'daemon', 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]['messageSender'],
  });
}

// ---------------------------------------------------------------- web chat send

const companionMessagePost: Scenario = {
  name: 'companion-message-post',
  drives: 'CompanionChatManager.postMessage with a clientMessageId (the web UI chat send, companion-chat-routes POST /messages) into an open chat holding 40 earlier messages, persistence on at the daemon\'s sessions directory. The model is a stand-in that holds its answer until the turn is stopped, so what is counted is the send and the start of its turn, not the reply.',
  entries: [`${P}/companion/companion-chat-manager.ts:765 CompanionChatManager.postMessage -> _postMessageInternal :796`, `${P}/companion/companion-chat-persistence.ts CompanionChatPersistence.appendMessages / writeMeta`],
  async setup(env): Promise<Instance> {
    const judgment = decisions(env, 'daemon');
    /** The model: answers nothing until the turn is stopped. */
    const holding: CompanionLLMProvider = {
      async *chatStream(_messages, options) {
        await new Promise<void>((resolve) => {
          if (options.abortSignal?.aborted) resolve();
          else options.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const manager = new CompanionChatManager({
      provider: holding, eventPublisher: { publishEvent: () => {} },
      sessionsDir: defaultSessionsDir(env.home), persist: true, rateLimiter: false,
    });
    await manager.init();
    // A chat with history; each run posts into a chat of its own so no send queues behind another's held turn.
    let chat = '';
    let sent = '';
    return {
      prepare() {
        chat = manager.createSession({ title: 'measured chat' }).id;
      },
      async op(run) {
        sent = `measure-send-${run}-${Date.now()}`;
        const messageId = await manager.postMessage(chat, 'What is on my calendar tomorrow?', 'measure-client', { clientMessageId: sent });
        assertOutcome(typeof messageId === 'string' && messageId.length > 0, 'the send returned no message id');
        return { messagesAccepted: 1 };
      },
      async verify() {
        await manager.flushSession(chat);
        const messages = manager.getMessages(chat);
        assertOutcome(messages.some((message) => message.role === 'user' && message.content === 'What is on my calendar tomorrow?'),
          `the sent message is not in chat ${chat} (${messages.length} messages)`);
      },
      async dispose() { await manager.close(); judgment.restore(); },
    };
  },
};

// ---------------------------------------------------------------- channel answer

const channelReplyFinal: Scenario = {
  name: 'channel-reply-final',
  drives: 'DaemonSurfaceDeliveryHelper.completeSurfaceReplyFromSurface: the surface that ran an agent reports its final answer to an ntfy conversation; the answer is stored in the session with its channel rows owed, sent through the reply pipeline and the ntfy plugin to a loopback ntfy server, and marked sent (settleChannelReply). Each run answers a conversation of its own, set up before the run.',
  entries: [`${P}/daemon/surface-delivery.ts:529 DaemonSurfaceDeliveryHelper.completeSurfaceReplyFromSurface`, `${P}/control-plane/session-broker.ts completeAgent / settleChannelReply`, `${P}/channels/reply-pipeline.ts ChannelReplyPipeline.deliverFinal`],
  async setup(env): Promise<Instance> {
    const judgment = decisions(env, 'daemon');
    const ntfy = await recorder();
    const configManager = daemonConfig(env);
    configManager.setMany([{ key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], localOwnerActor());
    const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore({ configManager }) });
    await routeBindings.start();
    const broker = sessionBroker(env, routeBindings);
    await broker.start();
    const channelPlugins = new ChannelPluginRegistry();
    const channelReplyPipeline = new ChannelReplyPipeline({ channelPlugins, routeBindings });
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies: new Map<string, PendingSurfaceReply>(),
      channelReplyPipeline, configManager, routeBindings, sessionBroker: broker, channelPlugins,
      secretsManager: { get: async () => null, getGlobalHome: () => null },
      serviceRegistry: { resolveSecret: async () => null },
      agentManager: { getStatus: () => null },
      authToken: () => null,
      surfaceDeliveryEnabled: () => true,
    } as unknown as ConstructorParameters<typeof DaemonSurfaceDeliveryHelper>[0]);
    // As the built-in ntfy plugin is registered: its reply goes to the helper's ntfy sender.
    channelPlugins.register({
      id: 'surface:ntfy', surface: 'ntfy', displayName: 'ntfy', capabilities: ['egress'],
      deliverReply: (pending, message) => helper.deliverNtfyAgentReply(pending as PendingSurfaceReply, message),
    } as Parameters<ChannelPluginRegistry['register']>[0]);
    let topic = '';
    let agentId = '';
    let sessionId = '';
    return {
      async prepare(run) {
        topic = `measure-topic-${run + 1}`;
        agentId = `agent-measure-${run + 1}`;
        const binding = await routeBindings.upsertBinding({ kind: 'channel', surfaceKind: 'ntfy', surfaceId: 'ntfy', externalId: topic, channelId: topic });
        const submitted = await broker.submitMessage({
          routeId: binding.id, surfaceKind: 'ntfy', surfaceId: 'ntfy', externalId: topic, body: `a question on ${topic}`, providerMessageId: `${topic}-1`,
        });
        await broker.bindAgent(submitted.session.id, agentId, submitted.input!.id);
        assertOutcome(helper.queueSurfaceReplyFromBinding(routeBindings.getBinding(binding.id), { agentId, task: `a question on ${topic}`, sessionId: submitted.session.id }),
          `no reply could be queued for ${topic}`);
        sessionId = submitted.session.id;
      },
      async op(run) {
        const body = `The answer for run ${run}: three pull requests are open.`;
        const attempted = await helper.completeSurfaceReplyFromSurface({ agentId, sessionId, body });
        assertOutcome(attempted, `the answer for ${topic} was not handed to its channel`);
        const arrived = ntfy.received.filter((entry) => entry.topic === topic);
        assertOutcome(arrived.length === 1 && arrived[0]!.body.includes('three pull requests'), `the ntfy server received ${arrived.length} messages on ${topic}`);
      },
      verify() {
        assertOutcome(broker.getMessages(sessionId, 1_000).some((message) => message.body.includes('three pull requests')), `the answer is not stored in session ${sessionId}`);
      },
      async dispose() {
        channelReplyPipeline.dispose();
        await broker.stop();
        await ntfy.close();
        ntfyOutboundDedup.reset();
        judgment.restore();
      },
    };
  },
};

// ---------------------------------------------------------------- scheduled run delivery

const automationRunSettle: Scenario = {
  name: 'automation-run-settle',
  drives: 'A scheduled run whose agent completed is settled by the automation manager (listJobs -> reconcile -> settleAutomationRun) and its result delivered to the job\'s one ntfy target on a loopback server (AutomationDeliveryManager.deliverJobRun); counted until the run records its delivery id. The run is started by runNow before each measured run.',
  entries: [`${P}/automation/manager-runtime-reconcile.ts:117 settleAutomationRun`, `${P}/automation/manager-runtime-delivery.ts maybeDeliverAutomationRun`, `${P}/automation/delivery-manager.ts AutomationDeliveryManager.deliverJobRun`],
  async setup(env): Promise<Instance> {
    const judgment = decisions(env, 'daemon');
    const ntfy = await recorder();
    const configManager = daemonConfig(env);
    configManager.setMany([{ key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfy.url }], localOwnerActor());
    const secretsManager = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: env.home, projectRoot: env.workspace });
    const subscriptionManager = new SubscriptionManager(join(env.home, '.goodvibes', 'subscriptions.json'), { secrets: secretsManager });
    const serviceRegistry = new ServiceRegistry({ user: join(env.home, '.goodvibes', 'services.json'), project: join(env.workspace, '.goodvibes', 'services.json') }, { secretsManager, subscriptionManager });
    const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore({ configManager }) });
    await routeBindings.start();
    const broker = sessionBroker(env, routeBindings);
    await broker.start();
    const deliveryManager = new AutomationDeliveryManager({
      serviceRegistry, secretsManager, configManager, routeBindings,
      artifactStore: new ArtifactStore({ rootDir: join(env.home, '.goodvibes', 'artifacts') }),
    });
    const agents = new Map<string, AgentRecord['status']>();
    let spawned = 0;
    const manager = new AutomationManager({
      configManager, routeBindings, sessionBroker: broker, deliveryManager,
      spawnTask: () => { const id = `agent-${++spawned}`; agents.set(id, 'running'); return id; },
      cancelTask: () => {},
      agentStatusProvider: {
        getStatus: (id: string) => {
          const status = agents.get(id);
          return status ? ({ id, status, task: 'nightly report', startedAt: Date.now(), completedAt: Date.now(), fullOutput: `the nightly report of ${id} is ready` } as unknown as AgentRecord) : null;
        },
      },
    });
    const job = await manager.createJob({
      name: 'nightly report', prompt: 'Write the nightly report.',
      schedule: { kind: 'at', at: Date.now() + 86_400_000 }, enabled: false,
      delivery: { mode: 'surface', includeSummary: true, includeLinks: false, targets: [{ kind: 'surface', surfaceKind: 'ntfy', address: 'job-target' }], fallbackTargets: [] },
    });
    let runId = '';
    let agentId = '';
    return {
      async prepare() {
        const run = await manager.runNow(job.id);
        runId = run.id;
        agentId = run.agentId!;
        // The run's start writes land before the measured settle.
        await until(() => manager.getRun(runId)?.status === 'running', `run ${runId} to be running`);
      },
      async op() {
        const before = ntfy.received.length;
        agents.set(agentId, 'completed');
        manager.listJobs();
        await until(() => (manager.getRun(runId)?.deliveryIds.length ?? 0) > 0, `run ${runId} to record its delivery`);
        assertOutcome(manager.getRun(runId)?.status === 'completed', `run ${runId} ended ${manager.getRun(runId)?.status}`);
        assertOutcome(ntfy.received.length === before + 1 && ntfy.received.at(-1)!.topic === 'job-target', `the target received ${ntfy.received.length - before} messages`);
      },
      async dispose() {
        await manager.stop();
        await broker.stop();
        await ntfy.close();
        ntfyOutboundDedup.reset();
        judgment.restore();
      },
    };
  },
};

// ---------------------------------------------------------------- approval

const PRIOR_APPROVALS = 50;

const approvalRaiseAnswer: Scenario = {
  name: 'approval-raise-answer',
  drives: `ApprovalBroker.raiseApproval (a tool asks) then resolveApproval (the owner approves) on the approvals store at the product path holding ${PRIOR_APPROVALS} earlier answered approvals; the asker's decision promise resolves.`,
  entries: [`${P}/control-plane/approval-broker.ts:493 ApprovalBroker.raiseApproval`, `${P}/control-plane/approval-broker.ts:545 ApprovalBroker.resolveApproval`],
  async setup(env): Promise<Instance> {
    const judgment = decisions(env, 'daemon');
    const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
    const storePath = shellPaths.resolveProjectPath('daemon', 'control-plane', 'approvals.json');
    const broker = new ApprovalBroker({ storePath });
    await broker.start();
    const ask = (callId: string) => ({
      callId, tool: 'exec', args: { command: `git push origin ${callId}` }, category: 'execute' as const,
      analysis: { classification: 'command', riskLevel: 'medium' as const, summary: `Push ${callId}`, reasons: [] },
    });
    for (let i = 0; i < PRIOR_APPROVALS; i++) {
      const raised = await broker.raiseApproval({ request: ask(`prior-${i}`) } as Parameters<ApprovalBroker['raiseApproval']>[0]);
      await broker.resolveApproval(raised.approval.id, { approved: true, actor: 'owner', actorSurface: 'tui', expectedRevision: raised.approval.revision });
      await raised.decision;
    }
    return {
      async op(run) {
        const raised = await broker.raiseApproval({ request: ask(`measured-${run}-${Date.now()}`) } as Parameters<ApprovalBroker['raiseApproval']>[0]);
        const resolved = await broker.resolveApproval(raised.approval.id, { approved: true, actor: 'owner', actorSurface: 'tui', expectedRevision: raised.approval.revision });
        assertOutcome(resolved.applied && resolved.record.status === 'approved', `the approval ended ${resolved.record?.status ?? 'missing'}`);
        const decision = await raised.decision;
        assertOutcome(decision.approved === true, 'the asker was not told it was approved');
      },
      async verify() {
        const reopened = new ApprovalBroker({ storePath });
        await reopened.start();
        const answered = reopened.listApprovals().filter((entry) => entry.status === 'approved').length;
        assertOutcome(answered > PRIOR_APPROVALS, `only ${answered} approved approvals are in the store after reopening`);
      },
      dispose() { judgment.restore(); },
    };
  },
};

export const scenarios: Scenario[] = [companionMessagePost, channelReplyFinal, automationRunSettle, approvalRaiseAnswer];
