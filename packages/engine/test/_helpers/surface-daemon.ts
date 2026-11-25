/**
 * A daemon's channel surface pieces over a scratch home, composed the way
 * `daemon/facade-composition.ts` composes them: real settings and secret store
 * (scratch-settings.ts), real service registry over the owner's own
 * `services.json`, real route bindings, session broker, channel policy,
 * approval broker, reply pipeline, surface-delivery helper and surface-action
 * helper; the adapters get the helper's own `buildSurfaceAdapterContext` /
 * `buildGenericWebhookAdapterContext`.
 *
 * The one stand-in is where the model begins (the agent runtime): `spawns`
 * records each spawn request and `spawn` answers what the agent runtime
 * answers (a started agent, or its refusal); the session broker's agent status
 * and message sender report no running agent. Context members the composition
 * fills that these paths never reach (gateway, runtime bus, companion chat,
 * approval actions) are left out, not replaced. The automation manager is
 * real over the scratch home; its task spawn is never called here.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../platform/src/platform/artifacts/index.ts';
import { AutomationDeliveryManager } from '../../platform/src/platform/automation/delivery-manager.ts';
import { AutomationManager } from '../../platform/src/platform/automation/manager-runtime.ts';
import { AutomationRouteStore } from '../../platform/src/platform/automation/store/routes.ts';
import { ChannelPluginRegistry } from '../../platform/src/platform/channels/plugin-registry.ts';
import { ChannelPolicyManager } from '../../platform/src/platform/channels/policy-manager.ts';
import { ChannelReplyPipeline } from '../../platform/src/platform/channels/reply-pipeline.ts';
import { RouteBindingManager } from '../../platform/src/platform/channels/route-manager.ts';
import type { ChannelPolicyRecord, ChannelSurface } from '../../platform/src/platform/channels/types.ts';
import { ServiceRegistry } from '../../platform/src/platform/config/service-registry.ts';
import { SubscriptionManager } from '../../platform/src/platform/config/subscriptions.ts';
import { ApprovalBroker } from '../../platform/src/platform/control-plane/approval-broker.ts';
import { SharedSessionBroker } from '../../platform/src/platform/control-plane/session-broker.ts';
import { DaemonSurfaceActionHelper } from '../../platform/src/platform/daemon/surface-actions.ts';
import { createFacadeWorkProposalStore } from '../../platform/src/platform/daemon/facade-work-proposal-store.ts';
import { createOwnerInbox } from '../../platform/src/platform/control-plane/owner-inbox.ts';
import { DaemonSurfaceDeliveryHelper } from '../../platform/src/platform/daemon/surface-delivery.ts';
import { isSurfaceDeliveryEnabled } from '../../platform/src/platform/daemon/surface-policy.ts';
import type { PendingSurfaceReply } from '../../platform/src/platform/daemon/types.ts';
import { isSurfaceFeatureGateEnabled } from '../../platform/src/platform/runtime/feature-flags/gates.ts';
import type { AgentRecord } from '../../platform/src/platform/tools/agent/record.ts';
import { scratchSettings } from './scratch-settings.ts';

export interface SpawnRequest {
  readonly input: unknown;
  readonly sessionId?: string | undefined;
}

export interface SurfaceDaemonOptions {
  /** The scratch home; made here when absent (the caller removes it). */
  readonly root?: string | undefined;
  /** Settings the owner wrote; a credential is kept in the secret store and the setting holds its reference. */
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  /** Secrets the owner stored by name (for services.json entries). */
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  /** The owner's own services.json entries. */
  readonly services?: Readonly<Record<string, Record<string, unknown>>> | undefined;
  /** Channel policies the owner set, per surface. */
  readonly policies?: Partial<Record<ChannelSurface, Partial<Omit<ChannelPolicyRecord, 'surface' | 'updatedAt'>>>> | undefined;
  /** The agent runtime's answer to a spawn request; a started agent by default. */
  readonly spawn?: ((request: SpawnRequest, count: number) => AgentRecord | Response) | undefined;
  /**
   * The conversation gate's pieces, as the facade composes them: the work-proposal store and the owner inbox over the
   * scratch home's one store (Waiting for you), both handed to the surface-action helper.
   */
  readonly conversationGate?: true | undefined;
}

export async function surfaceDaemon(options: SurfaceDaemonOptions = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'gv-surface-daemon-'));
  const { configManager, secretsManager } = await scratchSettings(options.settings ?? {}, root);
  for (const [key, value] of Object.entries(options.secrets ?? {})) await secretsManager.set(key, value, { scope: 'user' });
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  if (options.services) writeFileSync(join(home, 'services.json'), JSON.stringify(options.services));
  const subscriptionManager = new SubscriptionManager(join(home, 'subscriptions.json'), { secrets: secretsManager });
  const serviceRegistry = new ServiceRegistry({ user: join(home, 'services.json'), project: join(root, 'project', 'services.json') }, { secretsManager, subscriptionManager });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  await routeBindings.start();
  // The agent runtime is where the model begins: no agent is running.
  const agentRuntime = { getStatus: () => null };
  const sessionBroker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'), routeBindings, agentStatusProvider: agentRuntime, messageSender: { send: () => false },
  });
  await sessionBroker.start();
  const channelPolicy = new ChannelPolicyManager({ storePath: join(root, 'policies.json') });
  for (const [surface, patch] of Object.entries(options.policies ?? {})) await channelPolicy.upsertPolicy(surface as ChannelSurface, patch!);
  const approvalBroker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
  await approvalBroker.start();
  // The scheduled runs a channel control command can name (status, cancel, retry); none runs here.
  const automationManager = new AutomationManager({
    configManager, routeBindings, sessionBroker,
    deliveryManager: new AutomationDeliveryManager({ serviceRegistry, secretsManager, configManager, routeBindings, artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }) }),
    spawnTask: () => { throw new Error('no scheduled run is started in these cases'); },
    cancelTask: () => {},
    agentStatusProvider: agentRuntime,
  } as unknown as ConstructorParameters<typeof AutomationManager>[0]);
  const channelPlugins = new ChannelPluginRegistry();
  const channelReplyPipeline = new ChannelReplyPipeline({ channelPlugins, routeBindings });
  // As the facade decides it (facade.ts surfaceDeliveryEnabled), with no feature-flag manager: every surface gate open.
  const surfaceDeliveryEnabled = (surface: Parameters<typeof isSurfaceDeliveryEnabled>[1]) =>
    isSurfaceFeatureGateEnabled(null, surface) && isSurfaceDeliveryEnabled(configManager, surface);
  const delivery = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: new Map<string, PendingSurfaceReply>(),
    channelReplyPipeline, configManager, secretsManager, serviceRegistry, sessionBroker, routeBindings, channelPlugins, channelPolicy,
    agentManager: agentRuntime,
    authToken: () => null,
    surfaceDeliveryEnabled,
  } as unknown as ConstructorParameters<typeof DaemonSurfaceDeliveryHelper>[0]);
  const spawns: SpawnRequest[] = [];
  const trySpawnAgent = (input: unknown, _logLabel?: string, sessionId?: string): AgentRecord | Response => {
    const request = { input, sessionId };
    spawns.push(request);
    return options.spawn?.(request, spawns.length) ?? ({ id: `agent-${spawns.length}` } as AgentRecord);
  };
  const workProposals = options.conversationGate ? createFacadeWorkProposalStore(configManager, sessionBroker) : undefined;
  await workProposals?.init();
  const ownerInbox = options.conversationGate ? createOwnerInbox({ questionsPath: join(root, 'owner-inbox.sqlite'), approvals: approvalBroker }) : undefined;
  const helper = new DaemonSurfaceActionHelper({
    serviceRegistry, secretsManager, configManager, routeBindings, sessionBroker, channelPolicy, approvalBroker, automationManager,
    ...(workProposals ? { workProposals } : {}),
    ...(ownerInbox ? { ownerInbox } : {}),
    agentManager: agentRuntime,
    trySpawnAgent,
    queueSurfaceReplyFromBinding: (binding: never, input: never) => delivery.queueSurfaceReplyFromBinding(binding, input),
    queueWebhookReply: (input: never) => delivery.queueWebhookReply(input),
    surfaceDeliveryEnabled,
    signWebhookPayload: (body: string, secret: string) => delivery.signWebhookPayload(body, secret),
    deliverSurfaceNotice: (binding: never, text: string) => delivery.deliverSurfaceNotice(binding, text),
  } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  return {
    root, configManager, secretsManager, serviceRegistry, routeBindings, sessionBroker, channelPolicy, approvalBroker,
    channelPlugins, channelReplyPipeline, delivery, helper, spawns, trySpawnAgent, workProposals, ownerInbox,
    /** What the daemon hands a chat adapter. */
    adapterContext: () => helper.buildSurfaceAdapterContext(),
    /** What the daemon hands the generic webhook adapter. */
    webhookContext: () => helper.buildGenericWebhookAdapterContext(),
    /** Every user message the session broker stored, across sessions. */
    storedMessages: () => sessionBroker.listSessions(1_000).flatMap((session) => sessionBroker.getMessages(session.id, 1_000).filter((message) => message.role === 'user')),
    async stop() {
      helper.closeDelegatedTelegram();
      helper.closeProposalAnswers();
      ownerInbox?.dispose();
      workProposals?.dispose();
      channelReplyPipeline.dispose();
      automationManager.stop();
      await channelPolicy.stop();
      await sessionBroker.stop();
    },
  };
}

export type SurfaceDaemon = Awaited<ReturnType<typeof surfaceDaemon>>;
