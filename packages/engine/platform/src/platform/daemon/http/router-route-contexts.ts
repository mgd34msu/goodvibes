import { readDaemonHosted, readOwnerAdmitted, readProgramRegistration, readRequestClaims } from '@goodvibes/engine/daemon-api/control-routes';
import { ownersAgentProgram, ownersOwnPress, ownerHimself } from '../method-owner-decision.js';
import { localApprovalActions } from '../../control-plane/approval-actions.js';
import { admitEffects } from '../../security/effect-authority.js';
import type { Actor } from '../http-policy.js';
import type { ConfigManager } from '../../config/manager.js';
import type {
  ChannelDirectoryScope,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  ChannelSurface,
  RouteBindingManager,
  SurfaceRegistry,
} from '../../channels/index.js';
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
import { unknownChannelAction } from '../../channels/action-outcome.js';
import { channelProjectRefusal } from '../../channels/channel-project.js';
import { managedLockRefusalText } from '../../runtime/settings/host-setting-policy-read.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import type { JsonRecord } from '../helpers.js';
import type { WatcherRegistry } from '../../watchers/index.js';
import type { DaemonChannelRouteContext, InboundMailHealthLike } from './channel-route-types.js';
import type { DaemonIntegrationRouteContext } from './integration-route-types.js';
import type { DaemonKnowledgeRouteContext } from './knowledge-route-types.js';
import type { DaemonMediaRouteContext } from './media-route-types.js';
import type { DaemonSystemRouteContext } from './system-route-types.js';

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
  /** Undelivered daemon receipts (update, crash-restart, migration notices), left undelivered until acknowledged; owner-only ones for an owner-class reader. */
  readonly peekReceipts?: ((owner: boolean) => readonly { id: string; text: string; at: number }[]) | undefined;
  /** Marks receipts a reader has confirmed it received as delivered; a non-owner cannot take an owner-only one. */
  readonly acknowledgeReceipts?: ((ids: readonly string[], owner: boolean) => void) | undefined;
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
      invokeTool: async (surface, toolId, body) =>
        isChannelSurface(surface)
          ? input.channelPlugins.invokeTool(surface, toolId, body)
          : unknownChannelAction(surface as ChannelSurface, 'surface', toolId, []),
      listOperatorActions: async (surface) => {
        if (surface !== undefined && !isChannelSurface(surface)) return [];
        return input.channelPlugins.listOperatorActions(surface);
      },
      invokeOperatorAction: async (surface, actionId, body) =>
        isChannelSurface(surface)
          ? input.channelPlugins.invokeOperatorAction(surface, actionId, body)
          : unknownChannelAction(surface as ChannelSurface, 'surface', actionId, []),
      resolveTarget: async (surface, target) =>
        isChannelSurface(surface) ? input.channelPlugins.resolveTarget(surface, target) : null,
      authorizeActorAction: async (surface, authz) => {
        if (!isChannelSurface(surface)) return null;
        const { target, ...request } = authz;
        if (target === undefined) return input.channelPlugins.authorizeActorAction(surface, request);
        const targetSurface = target.surface;
        // A target no plugin serves cannot be authorized against.
        if (!isChannelSurface(targetSurface)) return null;
        return input.channelPlugins.authorizeActorAction(surface, { ...request, target: { ...target, surface: targetSurface } });
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
      upsertPolicy: async (surface, policy) =>
        isChannelSurface(surface) ? input.channelPolicy.upsertPolicy(surface, policy) : null,
      listAudit: (limit) => input.channelPolicy.listAudit(limit),
    },
    parseJsonBody: input.parseJsonBody,
    parseOptionalJsonBody: input.parseOptionalJsonBody,
    requireAdmin: input.requireAdmin,
    surfaceRegistry: input.surfaceRegistry,
    // "Project for this channel": only a registered project's folder (channels/channel-project.ts).
    channelProjectRefusal: (folder: string) => channelProjectRefusal(folder),
  };
}


export function buildSystemRouteContext(input: {
  readonly settingsPrecondition?: DaemonSystemRouteContext['settingsPrecondition'] | undefined;
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
  readonly resolveAuthenticatedPrincipal: (request: Request) => (NonNullable<ReturnType<NonNullable<DaemonSystemRouteContext['resolveAuthenticatedPrincipal']>>> & { readonly actor: Actor }) | null;
  readonly routeBindings: RouteBindingManager;
  readonly watcherRegistry: WatcherRegistry;
}): DaemonSystemRouteContext {
  return {
    // Every approval row and action outcome carries the reading for the caller.
    approvalBroker: localApprovalActions(input.approvalBroker),
    configManager: input.configManager,
    configLoosening: (key, value, options) => input.configManager.describeLoosening(key, value, options),
    // A managed lock, wherever it was recorded on this machine: refused before the owner is asked anything.
    managedLockRefusal: (key) => {
      let lock: ReturnType<ConfigManager['managedLockOf']>;
      try { lock = input.configManager.managedLockOf(key); }
      catch (error) { return `Nothing was changed: ${error instanceof Error ? error.message : String(error)}`; }
      return lock ? managedLockRefusalText(lock, isSecretBearingConfigKey(key)) : null;
    },
    // The one owner rule, as the daemon's dispatch told this request (daemon/method-owner-decision.ts): admitted at
    // once, refused by the effect table, or the owner's to decide (the dispatch then puts the same call to the owner's gate).
    settingsLoosenAdmission: (request) => {
      const principal = input.resolveAuthenticatedPrincipal(request);
      const actor = principal?.actor;
      if (actor === undefined) return 'refused';
      if (readOwnerAdmitted(request)) return 'allowed';
      // Served here without the dispatch (the precondition lane): the same rule, read from the request itself. The
      // owner's own press (their session, or their verified program with their claim), or their program's gate's mark.
      const claims = readRequestClaims(request);
      const credentialKind = (principal as { readonly credentialKind?: string | null } | null)?.credentialKind ?? undefined;
      const caller = { actor, credentialKind, registration: readProgramRegistration(request), personAsked: claims.personAsked,
        daemonHosted: readDaemonHosted(request) };
      if (ownersOwnPress(caller)) return 'allowed';
      // The gate's mark counts only from the owner's own verified program (their registered terminal program, their Agent
      // program, an Agent turn the daemon hosts); the Agent's credential alone is a script.
      if (claims.decidedByProgramGate && (ownersAgentProgram(caller) || ownerHimself(caller))) return 'allowed';
      return admitEffects(actor, ['settings.loosen']).kind === 'refused' ? 'refused' : 'ask-owner';
    },
    settingsPrecondition: input.settingsPrecondition,
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
      statusAsync: async () => toRecord(await input.platformServiceManager.statusAsync()),
      requestFromDaemon: (action) => input.platformServiceManager.requestFromDaemon(action),
    },
    recordApiResponse: input.recordApiResponse,
    requireAdmin: input.requireAdmin,
    requireAuthenticatedSession: input.requireAuthenticatedSession,
    resolveAuthenticatedPrincipal: input.resolveAuthenticatedPrincipal,
    routeBindings: input.routeBindings,
    watcherRegistry: input.watcherRegistry,
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
    artifactStore: input.artifactStore,
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
    knowledgeService: input.knowledgeService,
    knowledgeGraphqlService: input.knowledgeGraphqlService,
  };
}

/**
 * The services themselves: the route contracts name each input the routes have
 * checked, so a service whose input changes fails to compile here.
 */
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
    artifactStore: input.artifactStore,
    configManager: input.configManager,
    mediaProviders: input.mediaProviders,
    multimodalService: input.multimodalService,
    parseJsonBody: input.parseJsonBody,
    requireAdmin: input.requireAdmin,
    voiceService: input.voiceService,
    webSearchService: input.webSearchService,
  };
}

export function buildIntegrationRouteContext(input: DaemonIntegrationRouteContext): DaemonIntegrationRouteContext {
  return input;
}
