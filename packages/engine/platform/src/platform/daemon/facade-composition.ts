import { IdempotentReplayStore } from '../control-plane/idempotent-replay.js';
import { controlPlaneStorePath } from '../control-plane/control-plane-store-paths.js';
import { requestedEffortOverride, resolveEffortForModelSurface } from '../providers/reasoning-effort-surface.js';
import { assertSynchronousCurrent } from './reading-lifetime.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { createTelegramSourceAccountOwner } from '../channels/telegram/source-account.js';
import { composeDelegatedTelegramIntake } from './facade-delegated-telegram.js';
import { AgentManager } from '../tools/agent/index.js';
import { resolveHostBinding } from './host-resolver.js';
import { readControlPlaneStreamingMode } from './http/listener-admission.js';
import { composeHostedSessionsForFacade } from './hosted-sessions-composition.js';
import { createFacadeWorkProposalStore } from './facade-work-proposal-store.js';
import { readConversationGateConfig, type ConversationGateConfigReader } from '../agents/conversation-gate.js';
import { continuationContractOptions, decideContinuationEscalation } from '../agents/conversation-continuation.js';
import { gateSurfaceSpawn, type SurfaceIngressOrigin } from './surface-conversation-gate.js';
import { withGuestTurn } from '../security/turn-boundary.js';
import { conversationalTurnConfigReaderFrom, conversationalTurnSpawnOptions } from '../personal-capture/spawn-contract.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ConfigManager } from '../config/manager.js';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { setTelemetryIncludeRawPrompts } from '../runtime/telemetry/redaction-config.js';
import {
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
} from '../channels/index.js';
import { ChannelIngressAlarm } from '../channels/ingress-alarm.js';
import { ControlPlaneGateway } from '../control-plane/index.js';
import { buildSharedSessionAgentSpawnRoutingInput } from '../control-plane/session-intents.js';
import { ARRIVAL_INTENT_KEY } from '../control-plane/session-broker.js';
import type { ModelIdCandidate } from '../providers/model-id-resolution.js';
import {
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  REGULAR_KNOWLEDGE_DB_FILE,
  KnowledgeGraphqlService,
  KnowledgeSemanticService,
  KnowledgeService,
  KnowledgeStore,
  prepareConfiguredProjectContext,
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
} from '../knowledge/index.js';
import { createBuiltinChannelRuntime } from './facade-builtin-channels.js';
import { DaemonControlPlaneHelper } from './control-plane.js';
import { DaemonSurfaceDeliveryHelper, type SurfaceDeliveryLedgerEntry } from './surface-delivery.js';
import { type RouteSurfaceKind } from '../../events/routes.js';
import {
  emitDeliveryFailed,
  emitDeliveryQueued,
  emitDeliveryStarted,
  emitDeliverySucceeded,
} from '../runtime/emitters/deliveries.js';
import { emitBatchJobSettled } from '../runtime/emitters/providers.js';
import { DaemonSurfaceActionHelper } from './surface-actions.js';
import { DaemonTransportEventsHelper } from './transport-events.js';
import { DaemonHttpRouter } from './http/router.js';
import { DaemonWorkAdmission } from './work-admission.js';
import { configuredBrowserOrigins } from './http/browser-origin.js';
import { DaemonBatchManager } from '../batch/index.js';
import { CloudflareTunnelConnector } from '../cloudflare/tunnel-connector.js';
import { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { CompanionLLMProvider, CompanionProviderChunk } from '../companion/companion-chat-manager.js';
import { companionToolCallSession } from '../companion/companion-chat-turn-execution.js';
import { findModelDefinition, findModelDefinitionForProvider } from '../providers/registry-models.js';
import { CATALOG_PROVIDER_NAME_ALIASES } from '../providers/builtin-registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import { createAsyncDisposalScope, type AsyncDisposalScope } from '../runtime/async-disposal.js';
import type { DaemonConfig, PendingSurfaceReply } from './types.js';
import { PlatformServiceManager } from './service-manager.js';
import { resolveDaemonServiceDefault, resolveServiceUnitHome } from './daemon-service-default.js';
import type { ResolvedInboundTlsContext } from '../runtime/network/index.js';
import { createBrokeredPermissionManager } from '../runtime/permissions/permission-composition.js';
// Re-export type definitions from the dedicated types module.
export type {
  ResolvedDaemonFacadeRuntime,
  DaemonFacadeCollaborators,
  CreateDaemonFacadeCollaboratorsOptions,
} from './facade-types.js';
import type {
  ResolvedDaemonFacadeRuntime,
  DaemonFacadeCollaborators,
  CreateDaemonFacadeCollaboratorsOptions,
} from './facade-types.js';

type JsonBody = Record<string, unknown>;

function hasKnowledgeService(value: unknown): value is KnowledgeService {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.getStatus === 'function'
    && typeof candidate.ask === 'function'
    && typeof candidate.searchScoped === 'function';
}

function ensureAgentKnowledgeService(runtimeServices: RuntimeServices, ownership: AsyncDisposalScope): KnowledgeService {
  const existing = runtimeServices.agentKnowledgeService;
  if (hasKnowledgeService(existing)) {
    return existing;
  }

  const store = KnowledgeStore.forFamily({
    configManager: runtimeServices.configManager,
    dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
    family: 'agent',
  });
  ownership.registry.add('supplemental Agent knowledge store', () => store.close());
  const semanticLlm = createProviderBackedKnowledgeSemanticLlm(runtimeServices.providerRegistry, {
    timeoutMs: 20_000,
    maxConcurrent: 1,
  });
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    runtimeServices.memoryGovernor.admitExpensiveWork(label);
  const semanticService = new KnowledgeSemanticService(store, {
    llm: semanticLlm,
    maxLlmSourcesPerReindex: 3,
    isBackgroundPaused: () => runtimeServices.pauseController.isPaused('knowledge-self-improvement'),
    admitExpensiveWork,
  });
  ownership.registry.add('supplemental Agent knowledge semantic service', () => semanticService.dispose());
  const service = new KnowledgeService(store, runtimeServices.artifactStore, undefined, {
    memoryRegistry: runtimeServices.memoryRegistry,
    runtimeBus: runtimeServices.runtimeBus,
    semanticService,
    admitExpensiveWork,
  });
  ownership.registry.add('supplemental Agent knowledge service', () => service.dispose());
  semanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: runtimeServices.webSearchService,
    ingestService: service,
  }));
  service.attachRuntimeBus(runtimeServices.runtimeBus);
  // This service belongs to the facade, not the embedding host's graph.
  return service;
}

/**
 * Creates the CompanionLLMProvider adapter that bridges the daemon's
 * ProviderRegistry (chat-based) to the queue-driven async-generator interface
 * expected by CompanionChatManager.
 *
 * Extracted for testability: the adapter can be unit-tested in isolation
 * without constructing a full daemon facade.
 *
 * Error handling:
 * - If no provider is configured or the model is unavailable, the adapter
 *   immediately yields `{ type: 'error', error: 'No provider available ...' }`
 *   and returns. This is a graceful degradation, the companion chat session
 *   receives a structured error rather than an unhandled exception.
 * - If the underlying provider.chat() rejects mid-stream, the error is
 *   caught in the `.catch()` handler and surfaced as a final
 *   `{ type: 'error', error: <message> }` chunk after all buffered deltas
 *   have been yielded. The generator never throws; callers always receive
 *   a terminal chunk.
 */
export function createCompanionProviderAdapter(providerRegistry: ProviderRegistry): CompanionLLMProvider {
  return {
    async *chatStream(messages, options): AsyncIterable<CompanionProviderChunk> {
      let provider: import('../providers/interface.js').LLMProvider;
      try {
        if (options.model) {
          provider = providerRegistry.getForModel(options.model, options.provider ?? undefined);
        } else {
          const current = providerRegistry.getCurrentModel();
          provider = providerRegistry.getForModel(current.registryKey, current.provider);
        }
      } catch {
        // No provider is configured or the requested model/provider is unavailable.
        // Yield a structured error so the companion session receives feedback
        // rather than hanging or crashing.
        yield { type: 'error' as const, error: 'No provider available for companion chat' };
        return;
      }
      // Guard: if the selected provider has no credentials, yield a clean error
      // immediately instead of letting the upstream respond with a cryptic 401.
      if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
        const providerName = provider.name;
        const envVarHint = (provider as { authEnvVars?: readonly string[] }).authEnvVars?.[0]
          ?? (provider as { authEnvVars?: readonly string[] }).authEnvVars?.join(' or ')
          ?? 'the appropriate API key env var';
        yield {
          type: 'error' as const,
          error: `Provider '${providerName}' is not configured. Set ${envVarHint} or configure via the TUI settings.`,
        };
        return;
      }
      // Resolve the provider model id from the registry's ModelDefinition.
      // options.model is the provider-qualified registry key (for example
      // "inception:mercury-2"); provider.chat() receives the provider's id.
      let providerModelId: string;
      let modelDefinition: import('../providers/registry-types.js').ModelDefinition;
      try {
        const modelRegistry = providerRegistry.listModels();
        const def = options.model
          ? (options.provider
              ? findModelDefinitionForProvider(options.model, options.provider, modelRegistry, CATALOG_PROVIDER_NAME_ALIASES)
              : findModelDefinition(options.model, modelRegistry))
          : providerRegistry.getCurrentModel();
        if (!def) {
          throw new Error(`Model '${options.model}' is not in the provider registry.`);
        }
        providerModelId = def.id;
        modelDefinition = def;
      } catch (err) {
        yield {
          type: 'error' as const,
          error: err instanceof Error ? err.message : 'Requested companion model is not available',
        };
        return;
      }
      // Queue-based streaming bridge: onDelta pushes into a queue consumed by the generator.
      const queue: CompanionProviderChunk[] = [];
      let resolve: (() => void) | null = null;
      let done = false;
      let streamError: string | undefined;
      let streamFailure: unknown;
      let routeMetadata: Pick<CompanionProviderChunk, 'decisionRoute' | 'usage'> = {};
      let streamedContent = '';
      const push = (chunk: CompanionProviderChunk): void => {
        queue.push(chunk);
        resolve?.();
        resolve = null;
      };
      const effort = resolveEffortForModelSurface(options.reasoningEffort ?? '', modelDefinition);
      const chatPromise = provider.chat({
        ...(effort.value === undefined ? {} : { reasoningEffort: effort.value }),
        reasoningEffortSpec: effort.spec,
        model: providerModelId,
        ...(options.routingContext === undefined ? {} : { routingContext: options.routingContext }),
        messages: messages.map((m) => {
          if (m.role === 'tool') {
            return {
              role: 'tool' as const,
              callId: m.callId,
              content: m.content,
              ...(m.name ? { name: m.name } : {}),
            };
          }
          if (m.role === 'assistant') {
            return {
              role: 'assistant' as const,
              content: m.content,
              ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
            };
          }
          return { role: 'user' as const, content: m.content };
        }),
        tools: options.tools && options.tools.length > 0 ? [...options.tools] : undefined,
        systemPrompt: options.systemPrompt ?? undefined,
        signal: options.abortSignal,
        onDelta(delta) {
          if (delta.content) {
            streamedContent += delta.content;
            push({ type: 'text_delta', delta: delta.content });
          }
        },
      }).then((resp) => {
        routeMetadata = { ...(resp.decisionRoute ? { decisionRoute: resp.decisionRoute, usage: resp.usage } : {}) };
        if (resp.content && streamedContent.length === 0) {
          push({ type: 'text_delta', delta: resp.content });
        }
        if (resp.toolCalls?.length) {
          for (const tc of resp.toolCalls) {
            push({ type: 'tool_call', toolCallId: tc.id, toolName: tc.name, toolInput: tc.arguments });
          }
        }
      }).catch((err: unknown) => {
        // Mid-stream error: capture it so it can be yielded as a terminal chunk, kind and all.
        streamError = err instanceof Error ? err.message : String(err);
        streamFailure = err;
      }).finally(() => {
        done = true;
        resolve?.();
        resolve = null;
      });
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => { resolve = r; });
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
      await chatPromise;
      if (streamError) {
        yield { type: 'error' as const, error: streamError, failure: streamFailure };
      } else {
        yield { type: 'done' as const, ...routeMetadata };
      }
    },
  };
}

function daemonFacadeRuntimeInputs(config: DaemonConfig) {
  const ownedWorkingDir = config.runtimeServices?.workingDirectory ?? config.workingDir;
  const ownedHomeDirectory = config.runtimeServices?.homeDirectory ?? config.homeDirectory;
  const configManager = config.configManager ?? config.runtimeServices?.configManager;
  if (!config.runtimeServices && !configManager && (!ownedWorkingDir || !ownedHomeDirectory)) {
    throw new Error('DaemonServer requires explicit runtime services or explicit configManager plus workingDir/homeDirectory ownership.');
  }
  if (!config.runtimeServices && !configManager) {
    throw new Error('DaemonServer requires an explicit ConfigManager or runtimeServices.');
  }
  if (!config.runtimeServices && (!ownedWorkingDir || !ownedHomeDirectory)) {
    throw new Error('DaemonServer requires explicit workingDir and homeDirectory when composing runtime services.');
  }

  return { configManager: configManager ?? config.runtimeServices!.configManager,
    workingDirectory: ownedWorkingDir, homeDirectory: ownedHomeDirectory };
}

/** Async construction owns project activation before the synchronous graph can
 * capture its native work identity. Existing supplied graphs are already owned. */
export async function prepareDaemonFacadeRuntime(config: DaemonConfig): Promise<void> {
  const inputs = daemonFacadeRuntimeInputs(config);
  if (!config.runtimeServices) {
    await prepareConfiguredProjectContext(inputs.configManager, inputs.workingDirectory!, REGULAR_KNOWLEDGE_DB_FILE, { activate: true });
  }
}

export function resolveDaemonFacadeRuntime(
  config: DaemonConfig,
  supplementalOwnership: AsyncDisposalScope = createAsyncDisposalScope('daemon supplemental knowledge'),
  /** The bearer token this daemon serves with, read live; hosted sessions count it as the Worker operator token, as the status route does. */
  authToken?: () => string | null,
): ResolvedDaemonFacadeRuntime {
  try {
  const { configManager: resolvedConfigManager, workingDirectory: ownedWorkingDir, homeDirectory: ownedHomeDirectory } = daemonFacadeRuntimeInputs(config);
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => resolvedConfigManager.get(key)));
  const ownedRuntimeBus = config.runtimeServices?.runtimeBus ?? config.runtimeBus ?? new RuntimeEventBus();
  const runtimeServices = config.runtimeServices ?? createRuntimeServices({
    configManager: resolvedConfigManager,
    runtimeBus: ownedRuntimeBus,
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    getConversationTitle: () => 'goodvibes daemon',
    workingDir: ownedWorkingDir!,
    homeDirectory: ownedHomeDirectory!,
  });
  const agentKnowledgeService = ensureAgentKnowledgeService(runtimeServices, supplementalOwnership);
  const runtimeBus = runtimeServices.runtimeBus;
  const runtimeStore = runtimeServices.runtimeStore;
  const controlPlaneGateway = new ControlPlaneGateway({
    runtimeBus,
    runtimeStore,
    featureFlags: runtimeServices.featureFlags,
    server: {
      enabled: false,
      ...resolveHostBinding(
        (resolvedConfigManager.get('controlPlane.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
        String(resolvedConfigManager.get('controlPlane.host') ?? '127.0.0.1'),
        Number(resolvedConfigManager.get('controlPlane.port') ?? 3421),
        'controlPlane',
      ),
      streamingMode: readControlPlaneStreamingMode(resolvedConfigManager.get('controlPlane.streamMode')),
    },
  });

  // Register the gateway's replay ring with the MemoryGovernor: a REAL count
  // and a REAL trim (floor halves the retained history; flush clears it, and
  // replay degrades honestly to an empty backlog for reconnecting clients).
  runtimeServices.cacheRegistry.register('event-replay-ring', {
    name: 'control-plane event replay ring + surface messages',
    entryCount: () => controlPlaneGateway.retainedEventCount(),
    trim: (level) => controlPlaneGateway.trimRetainedEvents(level),
  });

  runtimeServices.knowledgeService.attachRuntimeBus(runtimeBus);
  agentKnowledgeService.attachRuntimeBus(runtimeBus);
  runtimeServices.sessionBroker.attachRuntimeBus(runtimeBus, (agentId) => runtimeServices.sessionBroker.findSessionForAgent(agentId));
  // Stamp automatic workspace checkpoints with the owning session id, resolved
  // the same way agent terminal events reconcile to a session (the broker's
  // activeAgentId map). Returns undefined when the triggering agent maps to no
  // shared session, the checkpoint is then left unstamped rather than guessed,
  // and sessions.changes.get / list({sessionId}) honestly report nothing for it.
  runtimeServices.workspaceCheckpointManager.setSessionResolver(({ agentId }) => {
    if (!agentId) return undefined;
    for (const s of runtimeServices.sessionBroker.listSessions(1000)) {
      if (s.activeAgentId === agentId) return s.id;
    }
    return undefined;
  });
  runtimeServices.routeBindings.attachRuntime({
    runtimeBus,
    runtimeStore,
  });
  runtimeServices.surfaceRegistry.attachRuntime(runtimeStore);
  runtimeServices.watcherRegistry.attachRuntime({
    runtimeBus,
    runtimeStore,
  });
  runtimeServices.automationManager.attachRuntime({
    runtimeBus,
    runtimeStore,
    deliveryManager: runtimeServices.deliveryManager,
  });
  runtimeServices.deliveryManager.setControlPlaneGateway(controlPlaneGateway);

  const companionChatManager = new CompanionChatManager({
    eventPublisher: controlPlaneGateway,
    provider: createCompanionProviderAdapter(runtimeServices.providerRegistry),
    // A provider failure moves the chat turn along provider.fallbackModels, the same rule as every turn.
    failoverRegistry: runtimeServices.providerRegistry,
    resolveDefaultRoute: () => {
      const model = runtimeServices.providerRegistry.getCurrentModel();
      return { provider: model.provider, model: model.id, systemPrompt: null, reasoningEffort: requestedEffortOverride(runtimeServices.configManager) };
    },
    modelReadsImages: (route) => {
      if (route.model === null) return runtimeServices.providerRegistry.getCurrentModel().capabilities.multimodal === true;
      const named = runtimeServices.providerRegistry.listModels()
        .find((model) => model.provider === route.provider && (model.id === route.model || model.registryKey === route.model));
      return named?.capabilities.multimodal === true;
    },
    // Explicitly opt into disk persistence for the daemon. Default is false
    // for tests and embedded hosts.
    persist: true,
    nativeDataWriter: runtimeServices.configManager.getNativeDataWriter(),
    // Honor the runtime's injected home so an isolated-home daemon never reads
    // or writes the real ~/.goodvibes/companion-chat.
    sessionsDir: runtimeServices.shellPaths.resolveUserPath('companion-chat', 'sessions'),
    // Live spine: companion sessions register INTO the shared broker at write
    // time so /api/sessions reflects them same-process (no restart).
    sessionBroker: runtimeServices.sessionBroker,
    // Wire the full ToolRegistry so LLM-emitted tool calls are executed.
    toolRegistry: runtimeServices.agentOrchestrator.getToolRegistry(),
    configManager: runtimeServices.configManager,
    // Asks ride the daemon's approval broker like every other background caller's, so a tool call that needs
    // the owner raises a card on every surface instead of being denied as if the user had refused it.
    permissionManager: createBrokeredPermissionManager({
      workspaceTrust: null,
      requestApproval: (input) => runtimeServices.approvalBroker.requestApproval(input),
      sessionOfAsk: companionToolCallSession,
      configManager: resolvedConfigManager,
      policyRuntimeState: runtimeServices.policyRuntimeState,
      hookDispatcher: runtimeServices.hookDispatcher,
      featureFlags: runtimeServices.featureFlags,
      userRuleStore: runtimeServices.userPermissionRuleStore,
      secretsManager: runtimeServices.secretsManager,
    }),
    hookDispatcher: runtimeServices.hookDispatcher,
    // The per-session limit follows runtime.companionChatLimiter.perSessionLimit on every check, not only the boot environment.
    rateLimiter: { configManager: runtimeServices.configManager },
    // Read on every sweep, so a change to the setting applies without a restart.
    closedSessionRetentionMs: () => {
      const days = runtimeServices.configManager.get('runtime.companionChat.closedRetentionDays');
      return typeof days === 'number' && days > 0 ? days * 86_400_000 : undefined;
    },
    runtimeBus,
    artifactStore: runtimeServices.artifactStore,
  });
  runtimeServices.approvalBroker.setPublisher(controlPlaneGateway);
  runtimeServices.sessionBroker.setEventPublisher((event, payload) => {
    controlPlaneGateway.publishEvent(event, payload);
  });

  // Hosted sessions: composed here because the engine publishes its lifecycle channel through the gateway built here.
  const hostedSessions = composeHostedSessionsForFacade(config.hostedSessions, runtimeServices, resolvedConfigManager, runtimeBus, controlPlaneGateway, authToken);

  // Host and port precedence: constructor-injected config.host/config.port win,
  // then fall back to the hostMode-aware binding resolution from configManager.
  // Directly-passed overrides are critical for tests (which bind random high
  // ports) and for embedders that construct DaemonServer with explicit values.
  const resolvedControlPlaneBinding = resolveHostBinding(
    (resolvedConfigManager.get('controlPlane.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
    String(resolvedConfigManager.get('controlPlane.host') ?? '127.0.0.1'),
    Number(resolvedConfigManager.get('controlPlane.port') ?? 3421),
    'controlPlane',
  );

  return {
    configManager: resolvedConfigManager,
    runtimeServices,
    ownsRuntimeServices: config.runtimeServices === undefined, // see facade-types.ts
    closeSupplementalResources: () => supplementalOwnership.close(),
    integrationHelpers: runtimeServices.integrationHelpers,
    port: config.port ?? resolvedControlPlaneBinding.port,
    host: config.host ?? resolvedControlPlaneBinding.host,
    agentManager: config.agentManager ?? runtimeServices.agentManager,
    userAuth: config.userAuth ?? runtimeServices.localUserAuthManager,
    automationManager: runtimeServices.automationManager,
    runtimeBus,
    runtimeStore,
    runtimeDispatch: runtimeServices.runtimeDispatch,
    controlPlaneGateway,
    gatewayMethods: runtimeServices.gatewayMethods,
    sessionBroker: runtimeServices.sessionBroker,
    approvalBroker: runtimeServices.approvalBroker,
    routeBindings: runtimeServices.routeBindings,
    deliveryManager: runtimeServices.deliveryManager,
    surfaceRegistry: runtimeServices.surfaceRegistry,
    channelPolicy: runtimeServices.channelPolicy,
    channelPlugins: runtimeServices.channelPlugins,
    watcherRegistry: runtimeServices.watcherRegistry,
    triggerManager: runtimeServices.triggerManager,
    // The login home, as the terminal apps use: the unit and the service's pid
    // file live there, whatever GOODVIBES_HOME this daemon's tree is under.
    // The definition it writes (boot promotion, update adoption, the web UI's
    // install) is the one `goodvibes-daemon install-service` writes: this
    // executable, this daemon's homes, no token.
    platformServiceManager: new PlatformServiceManager(resolvedConfigManager, {
      workingDirectory: runtimeServices.workingDirectory,
      homeDirectory: resolveServiceUnitHome(),
      launch: { homeDirectory: runtimeServices.homeDirectory, daemonHomeDirectory: config.daemonHomeDir },
      defaultServiceName: resolveDaemonServiceDefault(),
      featureFlags: runtimeServices.featureFlags,
    }),
    distributedRuntime: runtimeServices.distributedRuntime,
    voiceService: runtimeServices.voiceService,
    webSearchService: runtimeServices.webSearchService,
    knowledgeService: runtimeServices.knowledgeService,
    agentKnowledgeService,
    homeGraphService: runtimeServices.homeGraphService,
    projectPlanningService: runtimeServices.projectPlanningService,
    knowledgeGraphqlService: new KnowledgeGraphqlService(runtimeServices.knowledgeService),
    mediaProviders: runtimeServices.mediaProviders,
    multimodalService: runtimeServices.multimodalService,
    artifactStore: runtimeServices.artifactStore,
    serviceRegistry: runtimeServices.serviceRegistry,
    serveFactory: config.serveFactory ?? Bun.serve,
    githubWebhookSecret: config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? null,
    companionChatManager,
    hostedSessions,
  };
  } catch (error) {
    // Synchronous composition cannot await, but starts the same original drain
    // the asynchronous DaemonServer factory owns and observes before rejecting.
    supplementalOwnership.dispose();
    throw error;
  }
}

/**
 * Put a surface reply into the SAME delivery ledger automation deliveries use.
 *
 * Before this, the ledger observed automation deliveries only, so a channel
 * conversation could exchange messages all evening and the ledger still read
 * "0 queued, 0 started, 0 succeeded, 0 failed, 0 attempts". A dropped reply and
 * an idle daemon produced byte-identical evidence, which is how a real delivery
 * failure stayed invisible.
 */
export function recordSurfaceDeliveryAttempt(runtime: ResolvedDaemonFacadeRuntime, entry: SurfaceDeliveryLedgerEntry, startedAtById: Map<string, number>): void {
  // A kind outside the route list (a delivery surface without a route kind) keeps its own name:
  // filing it under another surface would credit its failures to the wrong channel.
  const surfaceKind = entry.surfaceKind as RouteSurfaceKind;
  const now = Date.now();
  const terminal = entry.phase === 'succeeded' || entry.phase === 'failed';
  if (entry.phase === 'started') {
    startedAtById.set(entry.deliveryId, now);
    // An attempt that never reports an end must not grow this without bound.
    if (startedAtById.size > 1_000) startedAtById.delete(startedAtById.keys().next().value!);
  }
  const startedAt = startedAtById.get(entry.deliveryId) ?? now;
  if (terminal) startedAtById.delete(entry.deliveryId);
  runtime.runtimeDispatch?.syncDeliveryAttempt({
    id: entry.deliveryId,
    runId: entry.sessionId ?? entry.agentId,
    jobId: entry.routeId ?? `surface:${surfaceKind}`,
    target: {
      kind: 'surface',
      surfaceKind: surfaceKind as never,
      ...(entry.routeId ? { routeId: entry.routeId } : {}),
      address: entry.targetId,
      label: `agent ${entry.agentId}`,
    },
    status: entry.phase === 'queued'
      ? 'pending'
      : entry.phase === 'started'
        ? 'sending'
        : entry.phase === 'succeeded' ? 'sent' : 'failed',
    ...(entry.phase === 'queued' ? {} : { startedAt }),
    ...(entry.phase === 'succeeded' || entry.phase === 'failed' ? { endedAt: now } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  }, `deliveries.${entry.phase}`);
  const bus = runtime.runtimeBus;
  if (!bus) return;
  const ctx = {
    sessionId: entry.sessionId ?? 'surface-reply',
    source: 'daemon-surface-delivery',
    traceId: entry.deliveryId,
  } as const;
  const common = {
    deliveryId: entry.deliveryId,
    jobId: entry.routeId ?? `surface:${surfaceKind}`,
    runId: entry.sessionId ?? entry.agentId,
    surfaceKind,
    targetId: entry.targetId,
  };
  if (entry.phase === 'queued') {
    emitDeliveryQueued(bus, ctx, { ...common, deliveryKind: 'reply' });
    return;
  }
  if (entry.phase === 'started') {
    emitDeliveryStarted(bus, ctx, { ...common, startedAt });
    return;
  }
  if (entry.phase === 'succeeded') {
    emitDeliverySucceeded(bus, ctx, { ...common, completedAt: now, durationMs: Math.max(0, now - startedAt) });
    return;
  }
  emitDeliveryFailed(bus, ctx, {
    ...common,
    failedAt: now,
    error: entry.error ?? 'surface reply was not delivered',
    retryable: false,
  });
}

export function createDaemonFacadeCollaborators(
  options: CreateDaemonFacadeCollaboratorsOptions,
): DaemonFacadeCollaborators {
  const { runtime } = options;

  // Report the startup opt-in. TelemetryApiService reads this daemon's live
  // config separately; safe views redact and HTTP raw reads also require scope.
  setTelemetryIncludeRawPrompts(
    runtime.configManager.get('telemetry.includeRawPrompts') === true,
  );

  const channelReplyPipeline = new ChannelReplyPipeline({
    channelPlugins: runtime.channelPlugins,
    routeBindings: runtime.routeBindings,
    runtimeBus: runtime.runtimeBus,
    // The style the spawn decided (conversation or report) shapes the reply; a contract is only the fallback.
    replyStyleOf: (agentId) => runtime.agentManager.getStatus(agentId)?.replyStyle,
    // A workstream is named from its own record, so one started before a restart still reads as its request.
    contractAsk: (contractId) => runtime.runtimeServices.contractRunner.get(contractId)?.ask,
    // Save, then send: a conversation's answer is recorded owed before its send and sent once it went out,
    // so a daemon that dies mid-send sends it again after its restart (resendOwedChannelReplies).
    recordFinalOwed: ({ sessionId, agentId }) => runtime.sessionBroker.markChannelReplyOwed(sessionId, agentId),
    // Settled per route: another conversation the same agent answers is still owed its own send, made at once.
    // The other routes' sends are not awaited: this runs inside the agent's own delivery section.
    recordFinalHanded: async ({ sessionId, agentId, routeId }) => {
      await runtime.sessionBroker.settleChannelReply(sessionId, agentId, routeId);
      void surfaceDeliveryHelper.deliverOwedRoutes(sessionId, agentId);
    },
  });
  // A completion stored while its channel send is still to come carries the owed mark in the same save.
  runtime.sessionBroker.setChannelReplyOwedProbe((agentId) => channelReplyPipeline.finalOwner(agentId) !== 'untracked');
  const surfaceDeliveryStartedAt = new Map<string, number>();
  const surfaceDeliveryHelper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: options.pendingSurfaceReplies,
    channelReplyPipeline,
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
    serviceRegistry: runtime.serviceRegistry,
    agentManager: runtime.agentManager,
    sessionBroker: runtime.sessionBroker,
    routeBindings: runtime.routeBindings,
    channelPlugins: runtime.channelPlugins,
    authToken: options.authToken,
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    recordDeliveryAttempt: (entry) => recordSurfaceDeliveryAttempt(runtime, entry, surfaceDeliveryStartedAt),
    channelPolicy: runtime.channelPolicy,
    recordApprovalPromptUndelivered: (approvalId, detail) => runtime.approvalBroker.recordRemoteUpdate(approvalId, {
      actor: 'daemon',
      actorSurface: 'daemon',
      note: `The approval prompt could not be shown in its conversation (${detail.reason}).`,
      metadata: { promptDelivery: { ...detail } },
    }),
    syncFinishedAgentTask: options.syncFinishedAgentTask,
  });
  // Every reply the pipeline could not put on a channel becomes a visible
  // failed delivery rather than an absence.
  channelReplyPipeline.setUndeliveredReporter((reply) => surfaceDeliveryHelper.recordUndeliveredReply(reply));
  channelReplyPipeline.setDeliveredReporter((reply) => surfaceDeliveryHelper.recordDeliveredReply(reply));
  // THE shared reply-routing point. The broker announces "this agent will
  // answer this channel message" from inside itself, so every ingress, a fresh
  // spawn, a message that landed in an existing live session, a shared-session
  // continuation, routes its answer back to the conversation it came from.
  runtime.sessionBroker.setSurfaceReplyBinder((binding) => {
    surfaceDeliveryHelper.ensureSurfaceReply(binding);
  });
  // The broker's own voice on a channel, used when it heals a route binding
  // that named an unusable session: the conversation moves to a fresh session
  // and the person on the other end is told why, instead of meeting an
  // assistant that has silently forgotten the last two days. Same delivery
  // helper every other unsolicited message uses, so the surface's escaper and
  // its refusal logging both apply.
  runtime.sessionBroker.setSurfaceNoticeSender((routeId, text) => {
    const binding = runtime.routeBindings.getBinding(routeId) ?? undefined;
    void surfaceDeliveryHelper.deliverSurfaceNotice(binding, text);
  });
  // One alarm, every inbound path; the channel health watcher announces what it holds.
  const ingressAlarm = new ChannelIngressAlarm();
  runtime.channelPlugins.setIngressAlarm(ingressAlarm);
  const workProposals = createFacadeWorkProposalStore(runtime.configManager, runtime.sessionBroker);

  const terminalPaymentSpan = options.paymentReplies?.mayRetireReceiveSpan.bind(options.paymentReplies);
  const telegramSourceAccounts = createTelegramSourceAccountOwner(purchaseId => terminalPaymentSpan?.(purchaseId) === true);
  // The one admission (work-admission.ts), shared with the schedulers the runtime graph built: closed by the
  // auto-updater for its restart, asked by the router, the WebSocket calls, the agent spawn and every scheduler.
  const workAdmission = runtime.runtimeServices.workAdmission ?? new DaemonWorkAdmission();
  const surfaceActionHelper = new DaemonSurfaceActionHelper({
    workAdmission,
    telegramSourceAccounts: telegramSourceAccounts.reader,
    delegatedTelegram: composeDelegatedTelegramIntake(runtime, telegramSourceAccounts.reader),
    paymentReplies: options.paymentReplies,
    ingressAlarm,
    serviceRegistry: runtime.serviceRegistry,
    secretsManager: runtime.runtimeServices.secretsManager,
    configManager: runtime.configManager,
    routeBindings: runtime.routeBindings,
    sessionBroker: runtime.sessionBroker,
    channelPolicy: runtime.channelPolicy,
    controlPlaneGateway: runtime.controlPlaneGateway,
    runtimeBus: runtime.runtimeBus,
    companionChatManager: runtime.companionChatManager,
    automationManager: runtime.automationManager,
    agentManager: runtime.agentManager,
    trySpawnAgent: options.trySpawnAgent,
    queueSurfaceReplyFromBinding: (binding, input) => surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    queueWebhookReply: (input) => surfaceDeliveryHelper.queueWebhookReply(input),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    signWebhookPayload: options.signWebhookPayload,
    handleApprovalAction: options.handleApprovalAction,
    approvalBroker: runtime.approvalBroker,
    resolveDefaultProviderModel: options.resolveDefaultProviderModel,
    workProposals,
    deliverSurfaceNotice: (binding, text) => surfaceDeliveryHelper.deliverSurfaceNotice(binding, text),
  });
  // A channel message from someone it admits who is not its owner never directs a running agent.
  runtime.sessionBroker.setGuestSenderRule((surfaceKind, userId) => surfaceActionHelper.senderIsGuest(surfaceKind, userId));
  // One store answers repeats of every write that takes the shared Idempotency-Key, on each path a call arrives by.
  const idempotentReplay = new IdempotentReplayStore(controlPlaneStorePath(runtime.runtimeServices.shellPaths, runtime.runtimeServices.surfaceRoot, 'idempotent-replay'));
  const controlPlaneHelper = new DaemonControlPlaneHelper({
    idempotentReplay,
    authToken: options.authToken,
    settingsLifetime: options.settingsLifetime,
    pairingTokens: runtime.runtimeServices.pairingTokens,
    userAuth: runtime.userAuth,
    agentManager: runtime.agentManager,
    controlPlaneGateway: runtime.controlPlaneGateway,
    gatewayMethods: runtime.gatewayMethods,
    host: runtime.host,
    port: runtime.port,
    distributedRuntime: runtime.distributedRuntime,
    trustProxyEnabled: options.trustProxyEnabled,
    runtimeBus: runtime.runtimeBus,
    allowedBrowserOrigins: () => configuredBrowserOrigins(runtime.configManager),
    dispatchApiRoutes: options.dispatchApiRoutes,
    parseJsonBody: options.parseJsonBody,
    requireAuthenticatedSession: options.requireAuthenticatedSession,
    workAdmission,
  });
  const transportEventsHelper = new DaemonTransportEventsHelper({
    runtimeBus: runtime.runtimeBus,
    hookDispatcher: runtime.runtimeServices.hookDispatcher,
    get host() { return options.transportBinding().host; },
    get port() { return options.transportBinding().port; },
    tlsState: options.tlsState,
  });
  const batchManager = new DaemonBatchManager({
    configManager: runtime.configManager,
    providerRegistry: runtime.runtimeServices.providerRegistry,
    // A finished job is published on the event stream, so a surface shows its result without polling.
    onJobSettled: (job) => {
      const bus = runtime.runtimeBus;
      if (!bus || job.status === 'queued' || job.status === 'submitting' || job.status === 'submitted' || job.status === 'running') return;
      emitBatchJobSettled(bus, { sessionId: 'daemon-batch', source: 'daemon-batch', traceId: job.id }, {
        jobId: job.id,
        status: job.status,
        provider: job.provider,
        model: job.model,
        completedAt: job.completedAt ?? job.updatedAt,
        ...(job.providerBatchId !== undefined ? { providerBatchId: job.providerBatchId } : {}),
        ...(job.error?.code !== undefined ? { errorCode: job.error.code } : {}),
        ...(job.error !== undefined ? { errorMessage: job.error.message } : {}),
      });
    },
  });
  batchManager.start();
  // The daemon runs cloudflared for the tunnel provisioning recorded, while the
  // integration is on, and follows the tunnel settings; the router stops it.
  const cloudflareTunnel = new CloudflareTunnelConnector({
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
  });
  cloudflareTunnel.start();
  // Messages and agreed work held while admission was closed start when a refused handover reopens it.
  workAdmission.onReopen(() => {
    runtime.sessionBroker.startWaitingMessages();
    void surfaceActionHelper.resumeAgreedWork().catch((error: unknown) => {
      logger.warn('Agreed work held for a restart could not be started after admission reopened', { error: summarizeError(error) });
    });
  });
  const httpRouter = new DaemonHttpRouter({
    workAdmission,
    idempotentReplay,
    listenerBinding: () => ({ ...options.transportBinding(), scheme: options.tlsState()?.tls ? 'https' : 'http' }),
    servingListener: options.servingListener,
    // The 401 names a refused credential the daemon knows: a device token over its
    // rotation age, an expired offer, or the shared token after it was revoked.
    describeCredentialRefusal: (token) => runtime.runtimeServices.pairingTokens.describePresentedRefusal(token, options.authToken()),
    settingsAuthority: {
      settingsLifetime: options.settingsLifetime ?? (() => null),
      captureSettingsAdminAuthority: (req) => controlPlaneHelper.captureSettingsAdminAuthority(req),
      withSettingsAdminAuthority: (req, authority, callback) => controlPlaneHelper.withSettingsAdminAuthority(req, authority, callback),
    },
    settingsImportAuthority: {
      settingsLifetime: options.settingsLifetime ?? (() => null),
      captureSettingsAdminAuthority: (req) => controlPlaneHelper.captureSettingsAdminAuthority(req),
      withSettingsAdminAuthority: (req, authority, callback) => controlPlaneHelper.withSettingsAdminAuthority(req, authority, callback),
      captureNativeExecutionAuthority: (req) => controlPlaneHelper.createNativeExecutionAuthority(controlPlaneHelper.extractAuthToken(req), undefined,
        controlPlaneHelper.authenticateRequest(req)?.principal.credentialKind),
      extractAuthToken: (req) => controlPlaneHelper.extractAuthToken(req),
      requireAdmin: (req) => controlPlaneHelper.requireAdmin(req),
    },
    nativeMutationHost: runtime.runtimeServices.nativeMutationHost,
    browserJudgment: runtime.runtimeServices.browserJudgment,
    configManager: runtime.configManager,
    serviceRegistry: runtime.serviceRegistry,
    userAuth: runtime.userAuth,
    agentManager: runtime.agentManager,
    automationManager: runtime.automationManager,
    approvalBroker: runtime.approvalBroker,
    controlPlaneGateway: runtime.controlPlaneGateway,
    gatewayMethods: runtime.gatewayMethods,
    providerRegistry: runtime.runtimeServices.providerRegistry,
    sessionBroker: runtime.sessionBroker,
    routeBindings: runtime.routeBindings,
    channelPolicy: runtime.channelPolicy,
    channelPlugins: runtime.channelPlugins,
    // A thunk, not a value: `builtinChannels` is constructed further down this
    // same function, and the route only runs on an HTTP request long after
    // composition finishes. Reading it eagerly here would be a temporal-dead-
    // zone error at startup.
    inboundMailHealth: () => builtinChannels.inboundMailHealth(),
    surfaceRegistry: runtime.surfaceRegistry,
    distributedRuntime: runtime.distributedRuntime,
    remoteBackends: runtime.runtimeServices.remoteBackends,
    watcherRegistry: runtime.watcherRegistry,
    voiceService: runtime.voiceService,
    webSearchService: runtime.webSearchService,
    mcpRegistry: runtime.runtimeServices.mcpRegistry,
    mcpConfigRoots: runtime.runtimeServices.shellPaths,
    knowledgeService: runtime.knowledgeService,
    agentKnowledgeService: runtime.agentKnowledgeService,
    homeGraphService: runtime.homeGraphService,
    projectPlanningService: runtime.projectPlanningService,
    knowledgeGraphqlService: runtime.knowledgeGraphqlService,
    mediaProviders: runtime.mediaProviders,
    multimodalService: runtime.multimodalService,
    artifactStore: runtime.artifactStore,
    memoryRegistry: runtime.runtimeServices.memoryRegistry,
    memoryConsolidation: { listReceipts: () => runtime.runtimeServices.memoryConsolidationScheduler.listReceipts() },
    memoryEmbeddingRegistry: runtime.runtimeServices.memoryEmbeddingRegistry,
    platformServiceManager: runtime.platformServiceManager,
    integrationHelpers: runtime.integrationHelpers,
    runtimeBus: runtime.runtimeBus,
    runtimeStore: runtime.runtimeStore,
    runtimeDispatch: runtime.runtimeDispatch,
    batchManager,
    cloudflareTunnel,
    githubWebhookSecret: runtime.githubWebhookSecret,
    authToken: options.authToken,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
    buildGenericWebhookAdapterContext: () => surfaceActionHelper.buildGenericWebhookAdapterContext(),
    authenticateRequest: (req) => controlPlaneHelper.authenticateRequest(req),
    extractAuthToken: options.extractAuthToken,
    requireAuthenticatedSession: options.requireAuthenticatedSession,
    requireAdmin: options.requireAdmin,
    requireRemotePeer: options.requireRemotePeer,
    invokeGatewayMethodCall: options.invokeGatewayMethodCall,
    queueSurfaceReplyFromBinding: (binding, input) => surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    completeSurfaceReplyFromSurface: (input) => surfaceDeliveryHelper.completeSurfaceReplyFromSurface(input),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    syncSpawnedAgentTask: options.syncSpawnedAgentTask,
    syncFinishedAgentTask: options.syncFinishedAgentTask,
    trySpawnAgent: options.trySpawnAgent,
    companionChatManager: runtime.companionChatManager,
    secretsManager: runtime.runtimeServices.secretsManager,
    swapManager: options.swapManager,
    resolveDefaultProviderModel: options.resolveDefaultProviderModel,
  });
  const providerRuntime = new ChannelProviderRuntimeManager({
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
    serviceRegistry: runtime.serviceRegistry,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
    ingressAlarm,
  });
  const builtinChannels = createBuiltinChannelRuntime({
    runtime, options, providerRuntime, surfaceActionHelper, surfaceDeliveryHelper, ingressAlarm, telegramSourceAccounts,
  });

  return {
    channelReplyPipeline,
    controlPlaneHelper,
    surfaceDeliveryHelper,
    surfaceActionHelper,
    transportEventsHelper,
    httpRouter,
    workAdmission,
    providerRuntime,
    builtinChannels,
    workProposals,
    paymentReplies: surfaceActionHelper.paymentReplies,
    ingressAlarm,
  };
}

export function configureDaemonSessionContinuation(options: {
  readonly sessionBroker: import('../control-plane/index.js').SharedSessionBroker;
  readonly trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel?: string, sessionId?: string) => import('../tools/agent/index.js').AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (binding: import('../automation/routes.js').AutomationRouteBinding | undefined, input: {
    readonly agentId: string;
    readonly task: string;
    readonly agentTask?: string | undefined;
    readonly contractId?: string | undefined;
    readonly sessionId?: string | undefined;
  }) => void;
  /** The live registry's model candidates, enables bare model id resolution in routing overrides. */
  readonly modelCandidates?: (() => readonly ModelIdCandidate[]) | undefined;
  /**
   * The surface helper holding the conversation-first gate's dependencies. A
   * follow-up in a shared session is the SAME message class the ingress gate
   * guards, so it gets the same treatment: conversation is answered outside
   * every contract, and a work-shaped follow-up is PROPOSED over the channel
   * it arrived on (a Response, reported here as "no agent started").
   *
   * Absent, an embedder that has not wired the gate, still fails closed via
   * `continuationContractOptions` below. A continuation never starts a contract
   * just because nobody installed a gate.
   */
  readonly surfaceActionHelper?: Pick<DaemonSurfaceActionHelper, 'conversationGateDeps' | 'senderIsGuest'> | undefined;
  /** Reads `conversationGate.*` so both halves of the gate obey one configuration. */
  readonly configReader?: ConversationGateConfigReader | undefined;
  /**
   * Whether a spawn would find a free agent slot now (`AgentManager.hasFleetCapacity`).
   * A message that must be read before it can start is not read while the fleet is full.
   */
  readonly hasFreeAgentSlot?: (() => boolean) | undefined;
}): void {
  const readingInputs = new Set<string>();
  options.sessionBroker.setContinuationRunner(async ({ sessionId, input, task, routeBinding }) => {
    const readingKey = JSON.stringify([sessionId, input.id]);
    if (readingInputs.has(readingKey)) return { disposition: 'held', reason: 'continuation-reading-in-progress' };
    readingInputs.add(readingKey);
    try {
      const spawnInput = {
        mode: 'spawn' as const,
        task,
        ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { modelCandidates: options.modelCandidates?.() }),
        context: `shared-session:${sessionId}`,
      };
      // Classify the OWNER's words (`input.body`), never the enriched
      // continuation task the broker builds from the transcript, that framing
      // reads as work no matter what the owner actually said.
      // A message held for capacity keeps what it was read as on arrival.
      const arrivalIntent = input.metadata[ARRIVAL_INTENT_KEY];
      const intent = arrivalIntent === 'work' || arrivalIntent === 'conversation' || arrivalIntent === 'unsure' ? arrivalIntent : undefined;
      // A follow-up from someone the channel admits who is not its owner is a guest's turn, as at ingress.
      const guest = input.surfaceKind !== undefined && options.surfaceActionHelper?.senderIsGuest(input.surfaceKind, input.userId) === true;
      const origin: SurfaceIngressOrigin | null = input.surfaceKind
        ? {
            surface: input.surfaceKind,
            text: input.body,
            ...(intent ? { intent } : {}),
            ...(guest ? { guest: true as const } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            ...(routeBinding?.channelId ?? input.externalId ? { channelId: routeBinding?.channelId ?? input.externalId } : {}),
            // Session keys may synthesize channel-as-thread. Only a bound route
            // carries the actual ingress thread identity used to answer proposals.
            ...((routeBinding ? routeBinding.threadId : input.threadId) ? { threadId: routeBinding ? routeBinding.threadId : input.threadId } : {}),
          }
        : null;
      // Work the owner already confirmed (an agreed proposal, a schedule, a
      // trigger, an on-exit chain) carries the marker and must not be re-asked;
      // a follow-up typed on a local surface starts its contract. Everything else is
      // conversation and goes through the gate.
      const escalation = decideContinuationEscalation(input, {
        ...(options.configReader ? { configReader: options.configReader } : {}),
      });
      const label = 'DaemonServer.sharedSessionFollowUp';
      let gateDeps = options.surfaceActionHelper?.conversationGateDeps();
      // The gate would read this message (a decision-model request) only to find
      // the fleet full; wait for a free agent first and read it once then.
      if (gateDeps && !escalation.startsContract && !origin?.intent && options.hasFreeAgentSlot?.() === false) {
        return { disposition: 'capacity', reason: 'every agent slot is taken' };
      }
      if (gateDeps && !escalation.startsContract) {
        const inputSnapshot = JSON.stringify(captureOwnedJson(input));
        const session = options.sessionBroker.getSession(sessionId);
        const routeSource = (binding: typeof routeBinding) => JSON.stringify(binding ? [binding.id, binding.surfaceKind, binding.surfaceId, binding.externalId, binding.channelId, binding.threadId, binding.sessionId] : null);
        const routeSnapshot = routeSource(routeBinding);
        const inherited = gateDeps.readingOptions.beforeAttempt;
        const sourceCurrent = gateDeps.captureReadingSource(origin);
        const gateConfig = JSON.stringify(readConversationGateConfig(gateDeps.configManager));
        const boundGateDeps = gateDeps;
        gateDeps = { ...gateDeps, readingOptions: { ...gateDeps.readingOptions, beforeAttempt: () => {
          assertSynchronousCurrent(inherited);
          assertSynchronousCurrent(sourceCurrent);
          if (JSON.stringify(readConversationGateConfig(boundGateDeps.configManager)) !== gateConfig) throw new Error('Conversation continuation gate config changed');
          const currentSession = options.sessionBroker.getSession(sessionId);
          const currentInput = options.sessionBroker.getInputs(sessionId, Number.MAX_SAFE_INTEGER).find(entry => entry.id === input.id);
          const currentRoute = input.routeId ? boundGateDeps.routeBindings.getBinding(input.routeId) : undefined;
          if (!session || !currentSession || currentSession.status === 'closed'
            || currentSession.createdAt !== session.createdAt || !currentInput || currentInput !== input || currentInput.state !== 'queued'
            || JSON.stringify(currentInput) !== inputSnapshot || routeSource(currentRoute) !== routeSnapshot) {
            throw new Error('Conversation continuation source is no longer current');
          }
        } } };
      }
      // Confirmed/local work keeps its original tools and task. Only conversation
      // receives the restricted list, conversational instruction and bound capture.
      const conversationalInput = escalation.startsContract ? spawnInput : {
        ...spawnInput,
        ...conversationalTurnSpawnOptions({ ...input, sessionId }, {
          configReader: conversationalTurnConfigReaderFrom(options.configReader),
          tools: input.routing?.tools,
          channel: {
            routed: true,
            ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
            ...(routeBinding?.channelId ?? input.externalId ? { address: routeBinding?.channelId ?? input.externalId } : {}),
            ...(guest ? { guest: true } : {}),
          },
        }),
      };
      const rawSpawn = (spawnArgs: Parameters<typeof options.trySpawnAgent>[0]) => guest && input.surfaceKind
        ? withGuestTurn(input.surfaceKind, () => options.trySpawnAgent(spawnArgs, label, sessionId))
        : options.trySpawnAgent(spawnArgs, label, sessionId);
      const spawned = escalation.startsContract
        ? rawSpawn(spawnInput)
        : gateDeps
          ? await gateSurfaceSpawn(gateDeps, origin, conversationalInput, label, sessionId)
          : rawSpawn({ ...conversationalInput, ...continuationContractOptions(input) });
      if (spawned instanceof Response) {
        // The fleet is full: the input waits, queued, for the next agent to end.
        if (spawned.status === 429) return { disposition: 'capacity', reason: 'every agent slot is taken' };
        if (spawned.status === 202) {
          const result: unknown = await spawned.clone().json();
          if (result && typeof result === 'object' && 'outcome' in result && result.outcome === 'waiting-for-capacity') {
            return { disposition: 'capacity', reason: 'every agent slot is taken' };
          }
          if (result && typeof result === 'object' && 'outcome' in result && result.outcome === 'work-proposed'
            && 'proposalId' in result && typeof result.proposalId === 'string') {
            const proposal = gateDeps?.workProposals?.listPending().find(entry => entry.id === result.proposalId);
            if (!proposal || !gateDeps) return { disposition: 'held', reason: 'work-proposal-unavailable' };
            const transferDeps = gateDeps;
            const assertTransferCurrent = () => {
              transferDeps.readingOptions.signal?.throwIfAborted();
              assertSynchronousCurrent(transferDeps.readingOptions.beforeAttempt);
              if (!transferDeps.workProposals?.listPending().includes(proposal)) throw new Error('Work proposal transfer is no longer current');
            };
            try {
              assertTransferCurrent();
              const consumed = await options.sessionBroker.markInputDelivered(sessionId, input.id, { consumed: true, beforeApply: assertTransferCurrent });
              if (!consumed || consumed.state !== 'completed') throw new Error('Work proposal source was not consumed');
              return { disposition: 'transferred', requestId: result.proposalId, inputConsumed: true };
            } catch (error) {
              if (gateDeps.workProposals?.listPending().includes(proposal)) {
                void gateDeps.workProposals.resolve(proposal.id, 'declined').catch((settleError: unknown) => {
                  logger.warn('Work proposal could not be declined after its source failed', { proposalId: proposal.id, error: summarizeError(settleError) });
                });
              }
              throw error;
            }
          }
        }
        return null;
      }
      options.queueSurfaceReplyFromBinding(routeBinding, {
        agentId: spawned.id,
        task: input.body,
        agentTask: task,
        ...(typeof spawned.contractId === 'string' && spawned.contractId.length > 0 ? { contractId: spawned.contractId } : {}),
        sessionId,
      });
      return { agentId: spawned.id };
    } finally { readingInputs.delete(readingKey); }
  });
}
