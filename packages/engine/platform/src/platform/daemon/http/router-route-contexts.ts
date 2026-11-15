import type { ConfigManager } from '../../config/manager.js';
import type {
  ChannelDirectoryScope,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  ChannelResolvedTarget,
  ChannelSurface,
  RouteBindingManager,
  SurfaceRegistry,
} from '../../channels/index.js';
import { logger } from '../../utils/logger.js';
import type { KnowledgeGraphqlService, KnowledgeService } from '../../knowledge/index.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { MediaProviderRegistry } from '../../media/index.js';
import type { MultimodalService } from '../../multimodal/index.js';
import type { VoiceService } from '../../voice/index.js';
import type { WebSearchService } from '../../web-search/index.js';
import type { IntegrationHelperService } from '../../runtime/integration/helpers.js';
import type { ApprovalBroker } from '../../control-plane/index.js';
import type { PlatformServiceManager } from '../service-manager.js';
import { toRecord } from '../../utils/record-coerce.js';
import type { JsonRecord } from '../helpers.js';
import type { WatcherRegistry } from '../../watchers/index.js';
import type { DaemonChannelRouteContext, InboundMailHealthLike } from './channel-route-types.js';
import type { DaemonIntegrationRouteContext } from './integration-route-types.js';
import type { DaemonKnowledgeRouteContext } from './knowledge-route-types.js';
import type { DaemonMediaRouteContext } from './media-route-types.js';
import type { DaemonSystemRouteContext, WatcherRecord } from './system-route-types.js';

/**
 * The optional providers the daemon facade hands the router for /status.
 *
 * Both are late-bound: the router is constructed before the lifecycle sidecar
 * and the cluster coordinator exist. Absent means the section is simply not in
 * the payload, which is what an embedder without those subsystems should see,
 * never a fabricated default.
 */
export interface DaemonStatusProviders {
  /**
   * The running artifact's own release version, when this host ships one. The
   * platform build is reported separately and is never a stand-in for it,
   * see ControlRouteContext.buildVersion in daemon-api/src/control-routes.ts.
   */
  readonly buildVersion?: (() => string | null) | undefined;
  /** Undelivered daemon receipts (update, crash-restart, migration notices). */
  readonly collectReceipts?: (() => readonly { id: string; text: string; at: number }[]) | undefined;
  /** The same receipts as {@link collectReceipts}, left undelivered until acknowledged. */
  readonly peekReceipts?: (() => readonly { id: string; text: string; at: number }[]) | undefined;
  /** Marks receipts a reader has confirmed it received as delivered. */
  readonly acknowledgeReceipts?: ((ids: readonly string[]) => void) | undefined;
  /**
   * Which node on this network currently consumes inbound channel messages,
   * for on-request inspection. Elections are otherwise invisible: no
   * notification, no transcript line, no message on any surface.
   */
  readonly collectClusterStatus?: (() => unknown) | undefined;
}

// Exhaustive by type: a surface added to ChannelSurface fails to compile here until it is listed.
const CHANNEL_SURFACES: Readonly<Record<ChannelSurface, true>> = {
  tui: true, web: true, slack: true, discord: true, ntfy: true, webhook: true, homeassistant: true,
  telegram: true, 'google-chat': true, signal: true, whatsapp: true, telephony: true, imessage: true,
  msteams: true, bluebubbles: true, mattermost: true, matrix: true,
};
const CHANNEL_DIRECTORY_SCOPES: Readonly<Record<ChannelDirectoryScope, true>> = {
  all: true, self: true, users: true, peers: true, groups: true, channels: true, threads: true, services: true, members: true,
};

function isChannelSurface(value: string): value is ChannelSurface {
  return Object.hasOwn(CHANNEL_SURFACES, value);
}

function isChannelDirectoryScope(value: string): value is ChannelDirectoryScope {
  return Object.hasOwn(CHANNEL_DIRECTORY_SCOPES, value);
}

/**
 * The route names a surface as a URL string. A surface no plugin can serve gets
 * the answer the registry gives for one it has no plugin for (null or empty),
 * without reaching it; every other argument is passed with its own type, so a
 * renamed or retyped service field fails to compile here.
 */
export function buildChannelRouteContext(input: {
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (request: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly surfaceRegistry: SurfaceRegistry;
  /** Supplied by a composition that has the builtin channel runtime. */
  readonly inboundMailHealth?: (() => InboundMailHealthLike | null) | undefined;
}): DaemonChannelRouteContext {
  return {
    ...(input.inboundMailHealth === undefined
      ? {}
      : { inboundMailHealth: input.inboundMailHealth }),
    channelPlugins: {
      listAccounts: async (surface) => {
        if (surface !== undefined && !isChannelSurface(surface)) return [];
        return input.channelPlugins.listAccounts(surface);
      },
      getAccount: async (surface, accountId) =>
        isChannelSurface(surface) ? input.channelPlugins.getAccount(surface, accountId) : null,
      getSetupSchema: async (surface, accountId) =>
        isChannelSurface(surface) ? input.channelPlugins.getSetupSchema(surface, accountId) : null,
      doctor: async (surface, accountId) =>
        isChannelSurface(surface) ? input.channelPlugins.doctor(surface, accountId) : null,
      listRepairActions: async (surface, accountId) =>
        isChannelSurface(surface) ? input.channelPlugins.listRepairActions(surface, accountId) : [],
      getLifecycleState: async (surface, accountId) =>
        isChannelSurface(surface) ? input.channelPlugins.getLifecycleState(surface, accountId) : null,
      runAccountAction: async (surface, action, accountId, body) =>
        isChannelSurface(surface) ? input.channelPlugins.runAccountAction(surface, action, accountId, body) : null,
      listCapabilities: async (surface) => {
        if (surface !== undefined && !isChannelSurface(surface)) return [];
        return input.channelPlugins.listCapabilities(surface);
      },
      listTools: async (surface) => {
        if (surface !== undefined && !isChannelSurface(surface)) return [];
        return input.channelPlugins.listTools(surface);
      },
      listAgentTools: (surface) => {
        if (surface !== undefined && !isChannelSurface(surface)) return [];
        return input.channelPlugins.listAgentTools(surface);
      },
      runTool: async (surface, toolId, body) =>
        isChannelSurface(surface) ? input.channelPlugins.runTool(surface, toolId, body) : null,
      listOperatorActions: async (surface) => {
        if (surface !== undefined && !isChannelSurface(surface)) return [];
        return input.channelPlugins.listOperatorActions(surface);
      },
      runOperatorAction: async (surface, actionId, body) =>
        isChannelSurface(surface) ? input.channelPlugins.runOperatorAction(surface, actionId, body) : null,
      resolveTarget: async (surface, target) =>
        isChannelSurface(surface) ? input.channelPlugins.resolveTarget(surface, target) : null,
      authorizeActorAction: async (surface, authz) => {
        if (!isChannelSurface(surface)) return null;
        // `target` is the record this registry's resolveTarget returned for the same request.
        const target = authz.target as ChannelResolvedTarget | undefined;
        return input.channelPlugins.authorizeActorAction(surface, { ...authz, target });
      },
      resolveAllowlist: async (surface, allowlist) =>
        isChannelSurface(surface) ? input.channelPlugins.resolveAllowlist(surface, allowlist) : null,
      editAllowlist: async (surface, allowlist) =>
        isChannelSurface(surface) ? input.channelPlugins.editAllowlist(surface, allowlist) : null,
      listStatus: () => input.channelPlugins.listStatus(),
      queryDirectory: async (surface, query) => {
        if (!isChannelSurface(surface)) return [];
        const { scope, ...rest } = query;
        // A scope no directory knows matches no entries.
        if (scope !== undefined && !isChannelDirectoryScope(scope)) return [];
        return input.channelPlugins.queryDirectory(surface, { ...rest, scope });
      },
    },
    channelPolicy: {
      listPolicies: () => input.channelPolicy.listPolicies(),
      upsertPolicy: async (surface, policy) => {
        if (!isChannelSurface(surface)) throw new Error(`Unknown channel surface: ${surface}`);
        // The route checked every field it builds this patch from (channel-routes.ts buildChannelPolicyPatchFields).
        return input.channelPolicy.upsertPolicy(surface, policy as Parameters<ChannelPolicyManager['upsertPolicy']>[1]);
      },
      listAudit: (limit) => input.channelPolicy.listAudit(limit),
    },
    parseJsonBody: input.parseJsonBody,
    parseOptionalJsonBody: input.parseOptionalJsonBody,
    requireAdmin: input.requireAdmin,
    surfaceRegistry: input.surfaceRegistry,
  };
}

export function buildSystemRouteContext(input: {
  readonly settingsPrecondition?: DaemonSystemRouteContext['settingsPrecondition'] | undefined;
  readonly settingsImportPrecondition?: DaemonSystemRouteContext['settingsImportPrecondition'] | undefined;
  readonly approvalBroker: ApprovalBroker;
  readonly configManager: ConfigManager;
  readonly credentialStatus: DaemonSystemRouteContext['credentialStatus'];
  readonly integrationHelpers: IntegrationHelperService | null;
  readonly inspectInboundTls: (surface: 'controlPlane' | 'httpListener') => unknown;
  readonly inspectOutboundTls: () => unknown;
  readonly isValidConfigKey: (key: string) => boolean;
  readonly isSecretBearingConfigKey: (key: string) => boolean;
  readonly coerceConfigValue?: ((key: string, value: unknown) => unknown) | undefined;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (request: Request) => Promise<JsonRecord | null | Response>;
  readonly platformServiceManager: PlatformServiceManager;
  readonly recordApiResponse: (
    request: Request,
    path: string,
    response: Response,
    clientKind?: DaemonSystemRouteContext['recordApiResponse'] extends (
      req: Request,
      path: string,
      response: Response,
      clientKind?: infer T,
    ) => Response
      ? T
      : never,
  ) => Response;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly requireAuthenticatedSession: (request: Request) => { username: string; roles: readonly string[] } | null;
  readonly resolveAuthenticatedPrincipal: NonNullable<DaemonSystemRouteContext['resolveAuthenticatedPrincipal']>;
  readonly routeBindings: RouteBindingManager;
  readonly swapManager: DaemonSystemRouteContext['swapManager'];
  readonly watcherRegistry: WatcherRegistry;
}): DaemonSystemRouteContext {
  const castWatcherRecord = (value: unknown): WatcherRecord | null => value as WatcherRecord | null;

  if (!input.swapManager) {
    logger.warn(
      'DaemonSystemRouteContext: initialized without swapManager, POST /config runtime.workingDir will be rejected',
    );
  }

  return {
    approvalBroker: input.approvalBroker,
    configManager: input.configManager,
    settingsPrecondition: input.settingsPrecondition,
    settingsImportPrecondition: input.settingsImportPrecondition,
    credentialStatus: input.credentialStatus,
    integrationHelpers: input.integrationHelpers,
    inspectInboundTls: input.inspectInboundTls,
    inspectOutboundTls: input.inspectOutboundTls,
    isValidConfigKey: input.isValidConfigKey,
    isSecretBearingConfigKey: input.isSecretBearingConfigKey,
    coerceConfigValue: input.coerceConfigValue,
    parseJsonBody: input.parseJsonBody,
    parseOptionalJsonBody: input.parseOptionalJsonBody,
    platformServiceManager: {
      status: () => toRecord(input.platformServiceManager.status()),
      install: () => input.platformServiceManager.install(),
      start: () => input.platformServiceManager.start(),
      stop: () => input.platformServiceManager.stop(),
      restart: () => input.platformServiceManager.restart(),
      uninstall: () => input.platformServiceManager.uninstall(),
    },
    recordApiResponse: input.recordApiResponse,
    requireAdmin: input.requireAdmin,
    requireAuthenticatedSession: input.requireAuthenticatedSession,
    resolveAuthenticatedPrincipal: input.resolveAuthenticatedPrincipal,
    swapManager: input.swapManager,
    routeBindings: {
      listBindings: () => input.routeBindings.listBindings(),
      upsertBinding: (binding) => input.routeBindings.upsertBinding(
        binding as Parameters<RouteBindingManager['upsertBinding']>[0],
      ),
      patchBinding: (bindingId, patch) => input.routeBindings.patchBinding(
        bindingId,
        patch as Parameters<RouteBindingManager['patchBinding']>[1],
      ),
      removeBinding: (bindingId) => input.routeBindings.removeBinding(bindingId),
    },
    watcherRegistry: {
      list: () => input.watcherRegistry.list(),
      removeWatcher: (watcherId) => input.watcherRegistry.removeWatcher(watcherId),
      registerWatcher: (watcher) => input.watcherRegistry.registerWatcher(
        watcher as Parameters<WatcherRegistry['registerWatcher']>[0],
      ) as WatcherRecord,
      getWatcher: (watcherId) => castWatcherRecord(input.watcherRegistry.getWatcher(watcherId)),
      startWatcher: (watcherId) => castWatcherRecord(input.watcherRegistry.startWatcher(watcherId)),
      stopWatcher: (watcherId, reason) => castWatcherRecord(input.watcherRegistry.stopWatcher(watcherId, reason)),
      runWatcherNow: async (watcherId) => castWatcherRecord(await input.watcherRegistry.runWatcherNow(watcherId)),
    },
  };
}

export function buildKnowledgeRouteContext(input: {
  readonly artifactStore: ArtifactStore;
  readonly configManager: ConfigManager;
  readonly inspectGraphqlAccess: DaemonKnowledgeRouteContext['inspectGraphqlAccess'];
  readonly normalizeAtSchedule: DaemonKnowledgeRouteContext['normalizeAtSchedule'];
  readonly normalizeEverySchedule: DaemonKnowledgeRouteContext['normalizeEverySchedule'];
  readonly normalizeCronSchedule: DaemonKnowledgeRouteContext['normalizeCronSchedule'];
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (request: Request) => Promise<JsonRecord | null | Response>;
  readonly parseJsonText: (raw: string) => JsonRecord | Response;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly resolveAuthenticatedPrincipal: (request: Request) => ReturnType<DaemonKnowledgeRouteContext['resolveAuthenticatedPrincipal']>;
  readonly knowledgeService: KnowledgeService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
}): DaemonKnowledgeRouteContext {
  return {
    artifactStore: input.artifactStore as unknown as DaemonMediaRouteContext['artifactStore'],
    configManager: input.configManager,
    inspectGraphqlAccess: input.inspectGraphqlAccess,
    normalizeAtSchedule: input.normalizeAtSchedule,
    normalizeEverySchedule: input.normalizeEverySchedule,
    normalizeCronSchedule: input.normalizeCronSchedule,
    parseJsonBody: input.parseJsonBody,
    parseOptionalJsonBody: input.parseOptionalJsonBody,
    parseJsonText: input.parseJsonText,
    requireAdmin: input.requireAdmin,
    resolveAuthenticatedPrincipal: input.resolveAuthenticatedPrincipal,
    knowledgeService: {
      getStatus: (scope, options) => input.knowledgeService.getStatus(
        scope as Parameters<KnowledgeService['getStatus']>[0],
        options,
      ),
      querySources: (query, options) => input.knowledgeService.querySources(
        query as Parameters<KnowledgeService['querySources']>[0],
        options,
      ),
      queryNodes: (query, options) => input.knowledgeService.queryNodes(
        query as Parameters<KnowledgeService['queryNodes']>[0],
        options,
      ),
      queryIssues: (query, options) => input.knowledgeService.queryIssues(
        query as Parameters<KnowledgeService['queryIssues']>[0],
        options,
      ),
      reviewIssue: (body) => input.knowledgeService.reviewIssue(
        body as unknown as Parameters<KnowledgeService['reviewIssue']>[0],
      ),
      getItemScoped: (id, scope, options) => input.knowledgeService.getItemScoped(
        id,
        scope as Parameters<KnowledgeService['getItemScoped']>[1],
        options,
      ),
      listConnectors: () => input.knowledgeService.listConnectors(),
      getConnector: (id) => input.knowledgeService.getConnector(id),
      doctorConnector: (id) => input.knowledgeService.doctorConnector(id),
      listProjectionTargets: (limit, scope, options) => input.knowledgeService.listProjectionTargets(
        limit,
        scope as Parameters<KnowledgeService['listProjectionTargets']>[1],
        options,
      ),
      listExtractions: (limit, sourceId, scope, options) => input.knowledgeService.listExtractions(
        limit,
        sourceId,
        scope as Parameters<KnowledgeService['listExtractions']>[2],
        options,
      ),
      listUsageRecords: (limit, filter) => input.knowledgeService.listUsageRecords(
        limit,
        filter as Parameters<KnowledgeService['listUsageRecords']>[1],
      ),
      listConsolidationCandidates: (limit, filter) => input.knowledgeService.listConsolidationCandidates(
        limit,
        filter as Parameters<KnowledgeService['listConsolidationCandidates']>[1],
      ),
      getConsolidationCandidate: (id) => input.knowledgeService.getConsolidationCandidate(id),
      listConsolidationReports: (limit) => input.knowledgeService.listConsolidationReports(limit),
      getConsolidationReport: (id) => input.knowledgeService.getConsolidationReport(id),
      listJobs: () => input.knowledgeService.listJobs(),
      getJob: (jobId) => input.knowledgeService.getJob(jobId),
      listJobRuns: (limit, jobId) => input.knowledgeService.listJobRuns(limit, jobId),
      listRefinementTasks: (limit, filter) => input.knowledgeService.listRefinementTasks(
        limit,
        filter as Parameters<KnowledgeService['listRefinementTasks']>[1],
      ),
      getRefinementTask: (id) => input.knowledgeService.getRefinementTask(id),
      runRefinement: (body) => input.knowledgeService.runRefinement(
        body as Parameters<KnowledgeService['runRefinement']>[0],
      ),
      cancelRefinementTask: (id) => input.knowledgeService.cancelRefinementTask(id),
      listSchedules: (limit) => input.knowledgeService.listSchedules(limit),
      getSchedule: (id) => input.knowledgeService.getSchedule(id),
      ingestUrl: (body) => input.knowledgeService.ingestUrl(
        body as Parameters<KnowledgeService['ingestUrl']>[0],
      ),
      ingestArtifact: (body) => input.knowledgeService.ingestArtifact(
        body as Parameters<KnowledgeService['ingestArtifact']>[0],
      ),
      syncBrowserHistory: (body) => input.knowledgeService.syncBrowserHistory(
        body as Parameters<KnowledgeService['syncBrowserHistory']>[0],
      ),
      importBookmarksFromFile: (body) => input.knowledgeService.importBookmarksFromFile(
        body as Parameters<KnowledgeService['importBookmarksFromFile']>[0],
      ),
      importUrlsFromFile: (body) => input.knowledgeService.importUrlsFromFile(
        body as Parameters<KnowledgeService['importUrlsFromFile']>[0],
      ),
      ingestConnectorInput: (body) => input.knowledgeService.ingestConnectorInput(
        body as Parameters<KnowledgeService['ingestConnectorInput']>[0],
      ),
      searchScoped: (query, options) => input.knowledgeService.searchScoped(
        query as Parameters<KnowledgeService['searchScoped']>[0],
        options as Parameters<KnowledgeService['searchScoped']>[1],
      ),
      ask: (body, options) => input.knowledgeService.ask(
        body as Parameters<KnowledgeService['ask']>[0],
        options,
      ),
      buildPacket: (task, writeScope, limit, options) => input.knowledgeService.buildPacket(
        task,
        writeScope,
        limit,
        options as Parameters<KnowledgeService['buildPacket']>[3],
      ),
      decideConsolidationCandidate: (id, decision, body) => input.knowledgeService.decideConsolidationCandidate(
        id,
        decision,
        body as Parameters<KnowledgeService['decideConsolidationCandidate']>[2],
      ),
      runJob: (jobId, body) => input.knowledgeService.runJob(
        jobId,
        body as Parameters<KnowledgeService['runJob']>[1],
      ),
      lint: () => input.knowledgeService.lint(),
      reindex: () => input.knowledgeService.reindex(),
      saveSchedule: (schedule) => input.knowledgeService.saveSchedule(
        schedule as Parameters<KnowledgeService['saveSchedule']>[0],
      ),
      deleteSchedule: (id) => input.knowledgeService.deleteSchedule(id),
      setScheduleEnabled: (id, enabled) => input.knowledgeService.setScheduleEnabled(id, enabled),
      renderProjection: (projection, options) => input.knowledgeService.renderProjection(
        projection as Parameters<KnowledgeService['renderProjection']>[0],
        options,
      ),
      materializeProjection: (projection) => input.knowledgeService.materializeProjection(
        projection as Parameters<KnowledgeService['materializeProjection']>[0],
      ),
      map: (mapInput, options) => input.knowledgeService.map(
        mapInput as Parameters<KnowledgeService['map']>[0],
        options,
      ),
    },
    knowledgeGraphqlService: input.knowledgeGraphqlService,
  };
}

export function buildMediaRouteContext(input: {
  readonly artifactStore: ArtifactStore;
  readonly configManager: ConfigManager;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly requireAdmin: (request: Request) => Response | null;
  readonly voiceService: VoiceService;
  readonly webSearchService: WebSearchService;
}): DaemonMediaRouteContext {
  return {
    artifactStore: input.artifactStore as unknown as DaemonMediaRouteContext['artifactStore'],
    configManager: input.configManager,
    mediaProviders: {
      status: () => input.mediaProviders.status(),
      findProvider: (capability, providerId) => input.mediaProviders.findProvider(
        capability,
        providerId,
      ) as unknown as DaemonMediaRouteContext['mediaProviders']['findProvider'] extends (...args: never[]) => infer R ? R : never,
    },
    multimodalService: {
      getStatus: () => input.multimodalService.getStatus(),
      listProviders: () => input.multimodalService.listProviders(),
      analyze: (body, options) => input.multimodalService.analyze(
        body as Parameters<MultimodalService['analyze']>[0],
        options,
      ),
      buildPacket: (analysis, detail, budgetLimit) => input.multimodalService.buildPacket(
        analysis as Parameters<MultimodalService['buildPacket']>[0],
        detail as Parameters<MultimodalService['buildPacket']>[1],
        budgetLimit,
      ),
      writeBackAnalysis: (analysis, body, options) => input.multimodalService.writeBackAnalysis(
        analysis as Parameters<MultimodalService['writeBackAnalysis']>[0],
        body as Parameters<MultimodalService['writeBackAnalysis']>[1],
        options,
      ),
    },
    parseJsonBody: input.parseJsonBody,
    requireAdmin: input.requireAdmin,
    voiceService: {
      getStatus: (enabled) => input.voiceService.getStatus(enabled),
      listVoices: (providerId) => input.voiceService.listVoices(providerId),
      synthesize: (providerId, body) => input.voiceService.synthesize(
        providerId,
        body as unknown as Parameters<VoiceService['synthesize']>[1],
      ),
      synthesizeStream: (providerId, body) => input.voiceService.synthesizeStream(
        providerId,
        body as unknown as Parameters<VoiceService['synthesizeStream']>[1],
      ),
      transcribe: (providerId, body) => input.voiceService.transcribe(
        providerId,
        body as unknown as Parameters<VoiceService['transcribe']>[1],
      ),
      openRealtimeSession: (providerId, body) => input.voiceService.openRealtimeSession(
        providerId,
        body as unknown as Parameters<VoiceService['openRealtimeSession']>[1],
      ),
    },
    webSearchService: {
      getStatus: () => input.webSearchService.getStatus(),
      search: (body) => input.webSearchService.search(
        body as unknown as Parameters<WebSearchService['search']>[0],
      ),
    },
  };
}

export function buildIntegrationRouteContext(input: DaemonIntegrationRouteContext): DaemonIntegrationRouteContext {
  return input;
}
