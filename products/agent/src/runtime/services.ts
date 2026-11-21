import { randomUUID } from 'node:crypto';
import type { SecretsManager } from '../config/secrets.ts';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { shell as runtimeShell } from '@goodvibes/engine/platform/platform/runtime';
import type { shell as RuntimeShell, bootstrap as RuntimeBootstrap } from '@goodvibes/engine/platform/platform/runtime';
import { readCheckpointGuardSettings, readCheckpointRegistrationSetting } from '../config/checkpoint-settings.ts';
import { createAgentResearchSourceOwner } from '@goodvibes/engine/terminal-shell/agent-turn/research-source-screening';
import { useConnectedHostRefusal } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import { createClassicProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security/source-screening/classic-owner';
import type { ProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security';
import { createWorkspaceRegistrationLiveChecker } from '../config/workspace-registration.ts';
import { FocusTracker } from '@/runtime/index.ts';
import { ServiceRegistry } from '@goodvibes/engine/platform/platform/config';
import { SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import { AutomationDeliveryManager, AutomationManager } from '@goodvibes/engine/platform/platform/automation';
import { ChannelPluginRegistry, RouteBindingManager, SurfaceRegistry } from '@goodvibes/engine/platform/platform/channels';
import { ChannelDeliveryRouter } from '@goodvibes/engine/platform/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker } from '@goodvibes/engine/platform/platform/control-plane';
import { createSessionConversationRewindPort } from './conversation-rewind-port.ts';
import { createClientApprovalRaiser, createConversationRewindHost, createDaemonConfigClient, createDaemonCredentialsClient, createDevicesClient, createWireSessionDispatch, readSurfaceAgentOutcome, watchApprovalUpdates } from '@goodvibes/engine/platform/platform/runtime/client';
import type { ConversationRewindHostClient, DaemonConfigClient, DaemonCredentialsClient, DaemonVerbCaller, DevicesClient, WireSessionDispatch } from '@goodvibes/engine/platform/platform/runtime/client';
import type { ApprovalRaiser, ProviderRegistryConstructionOptions, UserPermissionRuleAccess } from '@goodvibes/engine/platform/platform/runtime/client-services';
import { createAgentDaemonVerbCaller, resolveConnectedHostConnection, type AgentDaemonVerbCaller } from './client/daemon-verbs.ts';
import { createApprovalsView, type ApprovalsView } from './client/approvals-view.ts';
import { createAgentFleetUnion, type AgentFleetUnion } from './client/fleet-union.ts';
import { createHostedSessionRegistry, type HostedSessionRegistry } from './client/hosted-sessions.ts';
import { HOSTED_HANDOFF_CLIENT_ID, createHostedConversationHandoff, createHostedHandoffFileStore, type HostedConversationHandoff } from './client/hosted-handoff.ts';
import { readNotificationsMetadataOnly } from '@goodvibes/engine/platform/platform/runtime/notification-privacy';
import { readAgentHostSetting } from '../config/host-settings.ts';
import { agentDaemonCredentialsClient, installAgentDaemonCredentialsClient } from '../config/daemon-credential-routing.ts';
import { agentDaemonConfigClient, installAgentDaemonConfigClient } from '../config/daemon-config-routing.ts';
import type { LocalPermissionPrompt } from '@goodvibes/engine/platform/platform/runtime/client';
import { runHostedContinuation } from './continuation-spawn.ts';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { CacheRegistry, PauseController, type MemoryGovernor } from '@goodvibes/engine/platform/platform/runtime/memory';
import type { PermissionManager } from '@goodvibes/engine/platform/platform/permissions';
import { AGENT_SPINE_PARTICIPANT, SessionSpineClient, createSessionSpineRestProbe, createSessionSpineRestTransport, createSessionSpineReceiptAcknowledger, createSessionSpineReceiptConsumer } from '@goodvibes/engine/platform/platform/runtime/session-spine';
import { createSpineConnectionResolver } from './session-spine-rest-transport.ts';
import { MemorySpineClient } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import type { MemoryTransport } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import { createMemorySpineRestTransport } from './memory-spine-rest-transport.ts';
import { WatcherRegistry } from '@goodvibes/engine/platform/platform/watchers';
import { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import { HomeGraphService, KnowledgeService, ProjectPlanningService, ProjectWorkPlan } from '@goodvibes/engine/platform/platform/knowledge';
import { MediaProviderRegistry } from '@goodvibes/engine/platform/platform/media';
import { MultimodalService } from '@goodvibes/engine/platform/platform/multimodal';
import { AgentManager } from '@goodvibes/engine/platform/platform/tools';
import { AgentMessageBus } from '@goodvibes/engine/platform/platform/agents';
import { createContractIntake, type ContractIntake } from '@goodvibes/engine/platform/platform/contract';
import { type ApprovalDerivedHandlers } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import { AgentOrchestrator } from '@goodvibes/engine/platform/platform/agents';
import { ArchetypeLoader } from '@goodvibes/engine/platform/platform/agents';
import type { MemoryConsolidationRunReceipt } from '@goodvibes/engine/platform/platform/state';
import { wireRuntimePower } from '@goodvibes/engine/platform/platform/power';
import { gateConsolidationToLocalWriter } from './memory-consolidation-gate.ts';
import { AgentDaemonReceiptFeed, createDaemonReceiptConsumption } from './daemon-receipts.ts';
import { WorkspaceCheckpointManager, checkpointEligibilityRefusal, type CheckpointSessionResolver } from '@goodvibes/engine/platform/platform/workspace';
import { ProcessManager } from '@goodvibes/engine/platform/platform/tools';
import { ModeManager } from '@goodvibes/engine/platform/platform/state';
import { FileUndoManager } from '@goodvibes/engine/platform/platform/state';
import { MemoryRegistry } from '@goodvibes/engine/platform/platform/state';
import { MemoryStore } from '@goodvibes/engine/platform/platform/state';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { DomainDispatch, RuntimeStore } from '@goodvibes/engine/platform/platform/runtime/state';
import { DistributedRuntimeManager } from '@/runtime/index.ts';
import type { RemoteBackendHost } from '@goodvibes/engine/platform/platform/runtime/operations';
import { RemoteRunnerRegistry, RemoteSupervisor } from '@/runtime/index.ts';
import { IntegrationHelperService } from '@/runtime/index.ts';
import { VoiceProviderRegistry, VoiceService } from '@goodvibes/engine/platform/platform/voice';
import { type VoiceSetupService } from '@goodvibes/engine/platform/platform/runtime/voice-setup';
import { WebSearchProviderRegistry, WebSearchService } from '@goodvibes/engine/platform/platform/web-search';
import { MemoryEmbeddingProviderRegistry } from '@goodvibes/engine/platform/platform/state';
import { HookActivityTracker } from '@goodvibes/engine/platform/platform/hooks';
import { HookDispatcher, type HookWorkbench } from '@goodvibes/engine/platform/platform/hooks';
import { PluginManager } from '@goodvibes/engine/platform/platform/plugins';
import { BookmarkManager } from '@goodvibes/engine/platform/platform/bookmarks';
import { ProfileManager } from '@goodvibes/engine/platform/platform/profiles';
import { SessionManager } from '@goodvibes/engine/platform/platform/sessions';
import { CrossSessionTaskRegistry } from '@goodvibes/engine/platform/platform/sessions';
import type { ApiTokenAuditor } from '@goodvibes/engine/platform/platform/security';
import { UserAuthManager } from '@goodvibes/engine/platform/platform/security';
import { WebhookNotifier } from '@goodvibes/engine/platform/platform/integrations';
import { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import { DeterministicReplayEngine } from '@goodvibes/engine/platform/platform/core';
import { ProviderOptimizer } from '@goodvibes/engine/platform/platform/providers';
import { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import { ProviderCapabilityRegistry } from '@goodvibes/engine/platform/platform/providers';
import { CacheHitTracker } from '@goodvibes/engine/platform/platform/providers';
import { FavoritesStore } from '@goodvibes/engine/platform/platform/providers';
import { BenchmarkStore } from '@goodvibes/engine/platform/platform/providers';
import { ModelLimitsService } from '@goodvibes/engine/platform/platform/providers';
import { KeybindingsManager } from '../input/keybindings.ts';
import { SessionMemoryStore } from '@goodvibes/engine/platform/platform/core';
import { SessionLineageTracker } from '@goodvibes/engine/platform/platform/core';
import { SessionChangeTracker } from '@goodvibes/engine/platform/platform/sessions';
import { ExecutionPlanManager } from '@goodvibes/engine/platform/platform/core';
import { AdaptivePlanner } from '@goodvibes/engine/platform/platform/core';
import { FileStateCache } from '@goodvibes/engine/platform/platform/state';
import { ProjectIndex } from '@goodvibes/engine/platform/platform/state';
import { IdempotencyStore } from '@/runtime/index.ts';
import { OverflowHandler } from '@goodvibes/engine/platform/platform/tools';
import { HelperModel, ToolLLM } from '@goodvibes/engine/platform/platform/config';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import { type SessionSurface } from '@/runtime/index.ts';
import { createLazyMcpRegistry } from './mcp-lazy-start.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { agentTrustsScannedServer } from './lan-scan-consent-store.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { FeatureAnnouncementStore } from '@goodvibes/engine/platform/platform/runtime/feature-announcements';
import { type LocalhostFetchApproval } from '@goodvibes/engine/platform/platform/runtime/permissions/localhost-fetch-approval';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import type { WorkflowServices } from '@goodvibes/engine/platform/platform/tools';
import { AgentExecutionLedger } from '@goodvibes/engine/platform/platform/gate/policy';
import type { ToolDefinition } from '@goodvibes/engine/platform/platform/types';
import { VERSION } from '../version.ts';
import { ClientBuildGuard } from './client-build-compatibility.ts';
import { AGENT_DAEMON_BUILD_FLOOR, DaemonBuildGuard, createDaemonAdoptionGate, readDaemonStatusPayload } from './daemon-build-compatibility.ts';
import { composeRuntimeServices } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';

type WorktreeRegistry = RuntimeShell.WorktreeRegistry;
// The platform's FULL runtime-services shape. This graph's TYPE narrows or leaves
// out a few of its members (see the Omit on RuntimeServices below), because a
// surface that runs a loop and reaches a daemon for everything else dispatches
// rather than owns session work and mints no pairing tokens.
type PlatformRuntimeServices = RuntimeBootstrap.RuntimeServices;
type AssertTrue<T extends true> = T;
// Compile-pin: this graph must satisfy the CLIENT composition shape. That is the
// contract a surface product owes now, `ClientRuntimeServices` is what a turn
// needs in-process, and pinning it here is what stops a future edit from
// quietly re-growing a member back into daemon-grade furniture. It is checked
// against the full client shape (not `ClientRuntimeServicesFromHost`) precisely
// because this graph, unlike a daemon's, DOES carry the client-only members:
// surfaceRoot, permissionManager, requestApproval, the two spine clients, and
// the file-tool caches.
type _ClientRuntimeServicesPin = AssertTrue<RuntimeServices extends RuntimeBootstrap.ClientRuntimeServices ? true : false>;
type PlatformCompanionGraphService = NonNullable<PlatformRuntimeServices>['homeGraphService'];
// Compile-pin: the real HomeGraphService constructed below must remain
// assignable to the platform's own RuntimeServices#homeGraphService slot.
type _HomeGraphServicePin = AssertTrue<HomeGraphService extends PlatformCompanionGraphService ? true : false>;

class DisabledAgentWorktreeRegistry extends runtimeShell.WorktreeRegistry {
  public override async list(): Promise<Awaited<ReturnType<WorktreeRegistry['list']>>> {
    return [] as Awaited<ReturnType<WorktreeRegistry['list']>>;
  }

  public override attach(_path: string, _target: { sessionId?: string; taskId?: string }): void {
    throw new Error('GoodVibes Agent does not own local worktree attachment. Delegate build, fix, and review work to GoodVibes TUI.');
  }

  public override setState(_path: string, _state: Parameters<WorktreeRegistry['setState']>[1]): void {
    throw new Error('GoodVibes Agent does not own local worktree state. Delegate build, fix, and review work to GoodVibes TUI.');
  }

  public override async cleanup(_path: string): Promise<void> {
    throw new Error('GoodVibes Agent does not own local worktree cleanup. Delegate build, fix, and review work to GoodVibes TUI.');
  }
}

function createDisabledAgentWorktreeRegistry(workingDirectory: string): WorktreeRegistry {
  return new DisabledAgentWorktreeRegistry(workingDirectory);
}

/**
 * Managed voice provisioning: the surface this Agent exposes both to its own
 * slash commands (/voice status, /voice setup, /voice wake-status, /voice
 * wake-setup) and to the voice.local.* and voice.wake.* gateway verbs.
 *
 * An alias for the platform's own service type rather than a locally-declared shape.
 * It was declared locally while the platform's composition was internal; now that
 * createVoiceSetupService is exported, a separate declaration could only drift
 * from what is actually constructed, and the wake trio it grew (wakeStatus,
 * wakeProvision, wakeModelChunk) is exactly the kind of addition a hand-written
 * mirror silently misses until the gateway registration stops typechecking.
 */
export type AgentVoiceSetupService = VoiceSetupService;

/**
 * The narrow live-snapshot slice /health memory reads. A Pick over the platform's
 * real MemoryGovernor so the command surface can be handed the composed
 * governor without gaining pause/exit authority.
 */
export type AgentMemoryDiagnostics = Pick<MemoryGovernor, 'snapshot'>;

/**
 * How a runtime treats the live model-discovery sweep. See
 * {@link RuntimeServicesOptions.modelDiscovery}.
 */
export type ModelDiscoveryMode = 'refresh' | 'skip';

/**
 * The default is `'refresh'`, absent means refresh, which is what every
 * composition did before the option existed. Exported so the decision can be
 * driven directly rather than inferred from the source text of its call site.
 */
export function shouldRefreshModels(mode: ModelDiscoveryMode | undefined): boolean {
  return (mode ?? 'refresh') === 'refresh';
}

/**
 * How the graph builds this product's provider registry, as the terminal
 * app builds it: an absent key is an unconfigured provider, never a
 * construction failure.
 */
function buildAgentProviderRegistry(options: ProviderRegistryConstructionOptions): ProviderRegistry {
  return new ProviderRegistry(options);
}

export interface RuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  /** The live conversation's stored messages for the session this Agent runs; undefined for any other session. */
  readonly ownerConversationMessages?: (sessionId: string) => readonly object[] | undefined;
  /**
   * Maps a triggering turn/agent lifecycle event to the owning session id so the
   * WorkspaceCheckpointManager can stamp automatic (and defaulted explicit)
   * checkpoints with it. Without this, same-launch checkpoints are written with
   * an undefined session id and the session-scoped restore/rewind lookup filters
   * them out, so a checkpoint made this launch could not be activated until a
   * restart. Consulted live at each event, so a resolver reading a mutable
   * session-id ref reflects the current session without re-wiring.
   */
  readonly resolveSessionId?: CheckpointSessionResolver;
  readonly workingDir: string;
  readonly homeDirectory: string;
  /**
   * Host power seam opt-in. Left ABSENT, createRuntimeServices defaults to the
   * platform's non-spawning "unavailable" seam so a test-constructed runtime never
   * spawns systemd-inhibit inhibitors or a dbus-monitor sleep-edge watcher.
   * Only the real long-lived composition that owns the sleep edge (the embedded
   * interactive runtime, see bootstrap-core.ts) passes createHostPowerSeam()
   * to opt into live OS keep-awake / idle-inhibit.
   */
  readonly powerSeam?: Parameters<typeof wireRuntimePower>[0]['seam'];
  /**
   * What the runtime does about the provider registry's live model-discovery
   * sweep.
   *
   * DEFAULT `'refresh'`, which is what every composition did before this option
   * existed. The sweep reaches each configured provider's models endpoint and
   * writes `<configDir>/provider-models/<provider>.json`, so the runtime routes
   * against the models a provider actually serves rather than a stale list.
   *
   * `'skip'` starts nothing and leaves whatever list is already on disk in
   * place. It exists for callers whose process will not outlive the sweep: the
   * write is unawaited, and under test it landed AFTER the run had finished and
   * re-created a temp workspace that cleanup had already removed. That is a
   * property of the caller's lifetime, not a property of the product, so the
   * test setup opts out explicitly and the shipped default is unchanged.
   *
   * A named mode rather than a boolean because a third answer is foreseeable
   * (refresh-and-await, for a one-shot CLI that wants a fresh list before it
   * answers) and a boolean cannot grow one without changing every call site.
   */
  readonly modelDiscovery?: ModelDiscoveryMode;
  /**
   * Whether this graph claims the agent home as its single live writer.
   *
   * DEFAULT `'claim'`: the interactive agent is a singleton and a second one on
   * the same home is refused. A one-shot command that only reads (listing
   * sessions, showing the current model) passes `'off'` so it still works while
   * the agent is open; a command that writes the shared stores keeps the claim.
   */
  readonly homeSingleWriter?: 'claim' | 'off';
}

/**
 * This product's runtime graph.
 *
 * Two members are OMITTED from the platform's daemon-grade shape and re-declared to
 * the client contract, because this process is a client:
 *
 * - `sessionBroker` is the inbound-DISPATCH seam, not a persisting register.
 *   Work that arrives for a session this process hosts reaches the loop over
 *   `sessions.inputs.list` on the adopted daemon.
 * - `userPermissionRuleStore` is `UserPermissionRuleAccess`, read the rules
 *   this surface remembered, add one. The canonical store and its
 *   `permissions.rules.*` verbs are the daemon's.
 * - `pairingTokens` is not on the type. Minting, checking and revoking a
 *   per-device token is the work of a process that listens, and this one does
 *   not; a phone reaches this Agent's device tools through `devicesClient`,
 *   over the daemon's verbs.
 * - `triggerManager`, `channelPolicy`, `codeIndexStore` and
 *   `codeIndexReindexScheduler` are not on the type either: triggers are
 *   supervised by the host (`/triggers` reads the host's supervisor), channel
 *   ingress policy is the daemon's, and the repo code index is a TUI and daemon
 *   feature. Platform code typed to the daemon shape reads them through
 *   `asDaemonGradeView()`; the pairing tokens and the code index open only when read.
 *
 * Everything the daemon-grade shape declares is composed by the one runtime
 * graph (composeRuntimeServices) with this product's choices.
 */
export interface RuntimeServices extends Omit<PlatformRuntimeServices,
  'sessionBroker' | 'userPermissionRuleStore' | 'pairingTokens' | 'triggerManager' | 'channelPolicy' | 'codeIndexStore' | 'codeIndexReindexScheduler'> {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** This product's storage root, every per-product path derives from it. */
  readonly surfaceRoot: string;
  /**
   * The declare-once session-storage handle (platform/runtime/session-surface.ts),
   * built exactly once here from workingDirectory/homeDirectory/GOODVIBES_AGENT_SURFACE_ROOT.
   * Every session-persistence, SessionManager, and checkpoint call site threads
   * this through instead of re-deriving those three values independently, so a
   * writer and a reader can never disagree about where a file lives.
   */
  readonly surface: SessionSurface;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  readonly keybindingsManager: KeybindingsManager;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  readonly approvalBroker: ApprovalBroker;
  /**
   * What a surface SHOWS when it shows approvals: the daemon's record over
   * `approvals.list`, unioned with the asks the local broker still legitimately
   * holds, and the honest reason when the daemon's record could not be read.
   *
   * The broker above is not the whole list and must not be rendered as though
   * it were, an ask raised here is recorded on the daemon, so a list fed from
   * the broker alone shows "nothing pending" while three asks wait.
   * See client/approvals-view.ts.
   */
  readonly approvalsView: ApprovalsView;
  /**
   * Localhost dev-server fetch approval (ask once, persist
   * fetch.allowLocalhost for the project), same instance wired into the
   * orchestrator's tool deps; bootstrap-core must replay it there.
   */
  readonly localhostFetchApproval: LocalhostFetchApproval;
  /**
   * Announce-once store for default-on feature receipts (shared per-install
   * file under the control-plane config dir).
   */
  readonly featureAnnouncementStore: FeatureAnnouncementStore;
  /**
   * First-contained-exec-run announcer, same instance wired into the
   * orchestrator's tool deps; bootstrap-core must replay it there.
   */
  readonly onSandboxedRun: () => void;
  /**
   * The inbound-dispatch seam. Named `sessionBroker` because that is the name a
   * composition already carries, the NAME is shared so the two graphs stay
   * interchangeable; the TYPE is the client one. Bind a continuation runner
   * onto it, activate it with an adopted daemon's session inputs, and work
   * queued for a session this process hosts reaches the loop.
   */
  readonly sessionBroker: WireSessionDispatch;
  /**
   * The graph's persisting session register: what automation runs its jobs on,
   * and what the fleet, the distributed runtime, the memory governor and the
   * integration helpers read. Nothing dispatches through it, see
   * {@link sessionBroker} for where continuations arrive.
   */
  readonly automationSessionRegister: SharedSessionBroker;
  /**
   * Durable rules this surface remembered for its OWN asks, the client
   * interface, not the daemon's concrete store.
   */
  readonly userPermissionRuleStore: UserPermissionRuleAccess;
  /**
   * This graph as the platform's DAEMON-GRADE shape, for the three platform entry points
   * that still take it whole: `startHostServices` (adopt-only discovery),
   * `createRuntimeFoundationClients`, and the observability read models.
   *
   * It is the same graph with the session register in place of the dispatch
   * seam; every other member is this graph's own, and the pairing tokens and the
   * code index, opened on demand, open only if an entry point reads them.
   */
  readonly asDaemonGradeView: () => PlatformRuntimeServices;
  /**
   * How a permission ask leaves this process: raised on the daemon
   * (`approvals.raise`) AND prompted locally, first real answer wins.
   */
  readonly requestApproval: ApprovalRaiser;
  /**
   * The local prompt holder the ask seam reads through. The renderer patches
   * `requestPermission` onto it once it can draw one; until then an ask is
   * denied locally and the daemon's answer still wins the race.
   */
  readonly permissionPromptRef: { requestPermission: LocalPermissionPrompt };
  /** The foreground permission gate for this surface's turns. */
  readonly permissionManager: PermissionManager;
  /** The sessions this process is running, and whether one is mid-turn. */
  readonly hostedSessions: HostedSessionRegistry;
  /**
   * The other answer the continuation runner can give: hand an inbound channel
   * conversation to the daemon to host instead of answering it here. Off unless
   * `hostedSessions.promoteInboundConversations` says otherwise; exposed on the
   * graph so a surface can say which conversations were handed over.
   */
  readonly hostedHandoff: HostedConversationHandoff;
  /**
   * Checkpoint operations with the registered-workspace gate applied to
   * `create`. The raw {@link workspaceCheckpointManager} sits beside it for the
   * read/restore paths that were never gated. The consumer is the daemon-grade
   * gateway catalog composed over this graph (`checkpoints.*`); this product's
   * own slash commands and tools do not create checkpoints through it.
   */
  readonly guardedCheckpoints: Pick<
    WorkspaceCheckpointManager,
    'list' | 'create' | 'diff' | 'restore' | 'sessionChanges' | 'workspaceRoot' | 'resolveRoot'
  >;
  /** Every client seam's one plug into the connected host. */
  readonly daemonVerbs: DaemonVerbCaller;
  /**
   * The connected host's address and token, or the honest reason there is
   * none, the SAME resolution {@link daemonVerbs} uses.
   *
   * For the seams that need a long-lived stream rather than a call (the
   * approvals update stream, a hosted conversation's event stream). Sharing
   * the resolution is what keeps a surface from calling one daemon and
   * streaming from another.
   */
  readonly resolveConnectedHost: () => { readonly baseUrl: string; readonly token: string } | { readonly reason: string };
  /** Daemon-owned settings, read and written where they are acted on. */
  readonly daemonConfigClient: DaemonConfigClient;
  /** Credentials the daemon uses, written as one verified pair. */
  readonly daemonCredentialsClient: DaemonCredentialsClient;
  /** The paired-phone surface, as a client of the daemon's device runtime. */
  readonly devicesClient: DevicesClient;
  /**
   * Answers the daemon's conversation-rewind questions about the session this
   * process is holding. Started at bootstrap, released at shutdown.
   */
  readonly conversationRewindHost: ConversationRewindHostClient;
  readonly sessionSpineClient: SessionSpineClient;
  /** The client shape's name for {@link sessionSpineClient}; the same instance. */
  readonly sessionSpine: SessionSpineClient | null;
  /** The client shape's name for {@link memorySpineClient}; the same instance. */
  readonly memoryAccess: MemorySpineClient | null;
  /** Local file-tool state (surface-local by design). */
  readonly fileCache: FileStateCache;
  readonly projectIndex: ProjectIndex;
  /**
   * Connected-host honesty receipts ("updated from X to Y", "restarted after
   * a crash") captured off the spine probe's /status reads; the renderer
   * attaches at bootstrap and every receipt is delivered exactly once.
   */
  readonly daemonReceiptFeed: AgentDaemonReceiptFeed;
  /**
   * Performs ONE receipt-reading /status read (`?receipts=peek`) and pushes
   * what the daemon returned into {@link daemonReceiptFeed}, which acknowledges
   * each receipt (`?receipts=ack`) once it is on screen, so a receipt this
   * Agent never showed stays with the daemon. A plain liveness /status read is
   * receipt-neutral, so bootstrap invokes this exactly once per attach, see the
   * memory-spine adoption reconciler's `onAttach`. Best-effort: it never throws
   * and yields nothing on failure.
   */
  readonly consumeDaemonReceipts: () => Promise<void>;
  /**
   * May the daemon answering right now be adopted by this build?
   *
   * Reads `/status` for the daemon's version and judges it against this
   * product's build floor. False means the daemon is too old to serve what this
   * build depends on, and the adoption reconciler leaves the memory spine local
   * and the inbound dispatch unbound, the same state as no daemon at all, plus
   * one notice naming both versions.
   *
   * True when nothing could be read. An unreachable or truncated `/status` is
   * not evidence of an old daemon, and refusing on a dropped request would turn
   * one failed read into a lost adoption; a daemon that is not answering is the
   * reachability probe's business, not the floor's.
   */
  readonly mayAdoptDaemonBuild: () => Promise<boolean>;
  /**
   * Local idle-time memory-consolidation run receipts, one honest one-line
   * summary per run with something to report, rendered through the SAME
   * attach-time-notice idiom as {@link daemonReceiptFeed} (buffered until a
   * render sink attaches, delivered exactly once), but on its own feed so a
   * local consolidation run is never mislabeled "[Connected host]".
   */
  readonly memoryConsolidationReceiptFeed: AgentDaemonReceiptFeed;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  /**
   * Fleet rows from this process's registry unioned with the adopted daemon's,
   * local winning on a shared id. Read by the Activity modal so work the
   * daemon is running is visible here too.
   */
  readonly fleetUnion: AgentFleetUnion;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly artifactStore: ArtifactStore;
  /** Compatibility alias that intentionally points at the isolated Agent Knowledge service, not default knowledge. */
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: PlatformCompanionGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  /** The project work plan: the planning service's task rows for this project. */
  readonly workPlan: ProjectWorkPlan;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /**
   * The consumer half of the daemon-served memory spine (platform 1.1.0). Constructed
   * in LOCAL mode always (wrapping `memoryRegistry` directly); a deferred boot task
   * (see bootstrap.ts, mirroring the session-spine reachability probe) activates it
   * with the REST wire transport when the agent confirms an adopted daemon, and
   * deactivates it back to local on confirmed daemon loss. Every consumer that can
   * express its memory op through the five wire-covered methods (add/honestSearch/
   * get/updateReview/delete) should route through THIS client, never `memoryRegistry`
   * directly, so it automatically stops touching the local store file the moment a
   * daemon is adopted (the single-writer invariant, see memory-spine/client.ts).
   */
  readonly memorySpineClient: MemorySpineClient;
  /** The wire transport handed to `memorySpineClient.activate()` on daemon adoption; exposed so bootstrap can activate/reuse it without rebuilding the connection resolver. */
  readonly memorySpineTransport: MemoryTransport;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  /** Report-only native grant; captures stay held until explicitly configured. */
  readonly researchReportSourceOwner: ProtectedSourceOwner;
  /**
   * The owner first-party local reads go through (catalogs, settings, model
   * status, MCP servers, queues, personal ops): code-only screening on this
   * machine, no hosted provider, nothing sent anywhere, so it needs no consent
   * and is always bound. Research content keeps `researchReportSourceOwner`.
   */
  readonly localReadSourceOwner: ProtectedSourceOwner;
  readonly subscriptionManager: SubscriptionManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly profileManager: ProfileManager;
  readonly bookmarkManager: BookmarkManager;
  readonly sessionManager: SessionManager;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  readonly hookDispatcher: HookDispatcher;
  readonly hookActivityTracker: HookActivityTracker;
  readonly hookWorkbench: HookWorkbench;
  readonly pluginManager: PluginManager;
  readonly workflow: WorkflowServices;
  readonly voiceProviders: VoiceProviderRegistry;
  readonly voiceService: VoiceService;
  /**
   * Managed local-voice provisioning: status read + one-act install, mirroring
   * the platform's own daemon composition (platform/runtime/services.ts).
   */
  readonly voiceSetup: AgentVoiceSetupService;
  /**
   * platform-owned memory governance, composed here exactly as the platform's own
   * daemon composition does (constructed and STARTED by default, it is a
   * safety feature): samples RSS/heap, sheds registered caches by tier,
   * pauses deferrable background jobs, and trips on a genuine leak before
   * the OS OOM-kills the process. Serves ops.memory.get and /health memory.
   */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can observe and shrink. */
  readonly cacheRegistry: CacheRegistry;
  /** Backpressure seam the governor drives to pause/resume deferrable background jobs. */
  readonly pauseController: PauseController;
  readonly webSearchProviders: WebSearchProviderRegistry;
  readonly webSearchService: WebSearchService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly tokenAuditor: ApiTokenAuditor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly webhookNotifier: WebhookNotifier;
  /** OS-level terminal focus tracker (platform platform/runtime). */
  readonly focusTracker: FocusTracker;
  readonly replayEngine: DeterministicReplayEngine;
  readonly providerOptimizer: ProviderOptimizer;
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly providerRegistry: ProviderRegistry;
  readonly toolLLM: ToolLLM;
  /** The one helper route for supporting work; the orchestrator, resume summaries and titles share it. */
  readonly helperModel: HelperModel;
  readonly distributedRuntime: DistributedRuntimeManager;
  /** Registered execution backends `remote.peers.invoke` runs a command on (docker, ssh, cloud terminal, local process). */
  readonly remoteBackends: RemoteBackendHost;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly sessionLineageTracker: SessionLineageTracker;
  readonly sessionChangeTracker: SessionChangeTracker;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly idempotencyStore: IdempotencyStore;
  readonly overflowHandler: OverflowHandler;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly contractIntake: ContractIntake;
  readonly execPromptAnswerHandler: ApprovalDerivedHandlers['execPromptAnswerHandler'];
  readonly sandboxEscalationHandler: ApprovalDerivedHandlers['sandboxEscalationHandler'];
  readonly processManager: ProcessManager;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly executionLedger: AgentExecutionLedger;
  /**
   * Gives the execution ledger the main tool registry's definitions, once that
   * registry is composed: a tool that declares its effects or category is then
   * recorded by code, with no reading.
   */
  readonly bindToolDefinitions: (describe: (name: string) => ToolDefinition | undefined) => void;
  /**
   * Stop every poller this graph started (config watch, fleet tick, memory
   * governor, watcher registry, cross-session sweep, orchestration writer, push
   * sweep, both knowledge schedulers, the snapshot/retention/consolidation
   * schedulers, the spine keepalive) and release their handles.
   *
   * Restated from the platform interface because ownership differs here: this fork
   * composes no DaemonServer of its own, so nothing else will ever call this.
   * Every path that builds a graph owns taking it back down. Best-effort, total
   * and idempotent, an owner that throws is logged and the rest still come down.
   */
  dispose(): void;
  /** Wait for owned background work and storage to finish shutting down. */
  close(): Promise<void>;
  readonly integrationHelpers: IntegrationHelperService;
}

/**
 * One honest one-line summary of a consolidation run, or null for a run that
 * genuinely did nothing (nothing merged, archived, decayed, or proposed),
 * a quiet no-op run should not interrupt the user with an empty notice.
 */
export function describeMemoryConsolidationReceipt(receipt: MemoryConsolidationRunReceipt): string | null {
  const parts: string[] = [];
  if (receipt.merged.length > 0) parts.push(`merged ${receipt.merged.length}`);
  if (receipt.archived.length > 0) parts.push(`archived ${receipt.archived.length}`);
  if (receipt.decayed.length > 0) parts.push(`decayed ${receipt.decayed.length}`);
  if (receipt.proposed.length > 0) parts.push(`${receipt.proposed.length} proposed for review`);
  if (parts.length === 0) return null;
  return `Memory consolidation (${receipt.trigger}): ${parts.join(', ')}.`;
}


/** `target` with `members` laid over it, member by descriptor so a member opened on demand stays unopened. */
function withMembers<T extends object, O extends object>(target: T, members: O): Omit<T, keyof O> & O {
  return Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(target),
    ...Object.getOwnPropertyDescriptors(members),
  }) as Omit<T, keyof O> & O;
}

/**
 * This product's graph: the one every product composes (composeRuntimeServices)
 * with the Agent's choices, and the client seams only this surface has added over it.
 *
 * The choices: the home memory store; no separate workspace trust policy; asks
 * raised on the daemon while prompting here, and MCP questions answered by the
 * person; the agent's own knowledge store as the project's, with no wiki;
 * approvals, watchers and channel policies kept per user, since one Agent runs
 * per home; the home claimed as its single writer; hooks that cannot spawn an
 * agent; the code index and pairing tokens opened only if something reads them;
 * no local worktree attachment; the built-in verbs, triggers and routines left
 * to the daemon.
 */
export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const configManager = options.configManager;
  const runtimeBus = options.runtimeBus;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });

  // ── The client seams ─────────────────────────────────────────────────────
  // One verb caller, handed to every seam. Connection resolution stays here (see
  // client/daemon-verbs.ts) because deciding which daemon this agent trusts is a
  // trust-boundary concern. The approval-update stream resolves the SAME host
  // and token from the same options: two resolutions would be two hosts the day
  // they disagree. The build verdict on the attached host is set once the build
  // guard exists.
  let connectedHostRefusal: () => string | undefined = () => undefined;
  const connectedHostAccess = { configManager, homeDirectory, hostRefusal: () => connectedHostRefusal() };
  // Every other connected-host path of this process (schedules, operator tools, slash-command routes, owner
  // questions, Activity, occasions) builds its own selection; the one build verdict reaches them all here.
  useConnectedHostRefusal(() => connectedHostRefusal());
  const daemonVerbs: AgentDaemonVerbCaller = createAgentDaemonVerbCaller(connectedHostAccess);
  // What this process is actually running, answered from itself rather than from
  // the daemon's cross-surface register. Feeds inbound dispatch, the
  // conversation-rewind host and the consolidation idle gate.
  const hostedSessions = createHostedSessionRegistry(runtimeBus);
  // The prompt this surface draws. Late-bound: the renderer patches it in after
  // boot, which is why the raiser takes a getter rather than the function.
  const permissionPromptRef: { requestPermission: LocalPermissionPrompt } = {
    requestPermission: async () => ({ approved: false, remember: false }),
  };
  // An ask is raised on the daemon AND prompted here, and the first real answer
  // wins. Raising it only into this process's own broker would leave it
  // invisible to every other surface and to the phone that can answer it.
  const requestApproval: ApprovalRaiser = createClientApprovalRaiser({
    verbs: daemonVerbs,
    actor: 'agent',
    localPrompt: () => permissionPromptRef.requestPermission,
    sessionId: () => options.resolveSessionId?.({}),
  });
  const keybindingsManager = new KeybindingsManager({
    configPath: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'keybindings.json'),
  });
  // Local consolidation receipts, on their own feed so a local run is never
  // labelled "[Connected host]".
  const memoryConsolidationReceiptFeed = new AgentDaemonReceiptFeed();
  // The registered-workspace gate for checkpoints, set when the graph builds its
  // checkpoint manager. The working directory is fixed for the process; only its
  // registration state is live.
  const checkpointsRegistration = createWorkspaceRegistrationLiveChecker(shellPaths, workingDirectory);
  const checkpointsGuarded = (): boolean => readCheckpointRegistrationSetting(configManager) === 'guarded';
  const checkpointsCurrentlyAllowed = (): boolean => {
    const eligibility = checkpointsRegistration();
    return (eligibility.state === 'readable' && eligibility.resolution.status === 'covered') || checkpointsGuarded();
  };

  try {
    return composeRuntimeServices({
      surface: 'agent',
      roots: {
        surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
        workingDir: workingDirectory,
        homeDirectory,
        sessionStorePath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'sessions.json'),
        pairingTokenPath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'pairing-tokens.json'),
        // One Agent runs per home, so its approvals, watchers and channel policies are the user's.
        stateScope: 'home',
        // The activity log and telemetry ledger this product writes under the working directory.
        logDir: shellPaths.resolveProjectPath('logs'),
        telemetryDir: shellPaths.resolveProjectPath('telemetry'),
      },
      memoryStore: 'home',
      // The Agent has no separate workspace trust policy.
      workspaceTrust: 'none',
      permissionHost: { raiseApproval: () => requestApproval, personElicitation: true },
      hostSeams: {
        nativeDataWriter: configManager.getNativeDataWriter(),
        runtimeBus,
        runtimeStore: options.runtimeStore,
        configManager,
        featureFlags: options.featureFlags,
        getConversationTitle: options.getConversationTitle,
        ownerConversationMessages: options.ownerConversationMessages,
        keybindingsManager,
        localUserAuthManager: options.localUserAuthManager,
        // Launch tolerance: an absent key is an unconfigured provider, never a construction failure.
        providerRegistryFactory: buildAgentProviderRegistry,
        modelDiscovery: shouldRefreshModels(options.modelDiscovery) ? 'run' : 'skip',
        // The same rule as the start-up pass: network servers only while network scanning is on.
        trustScannedServer: (server, paths) => agentTrustsScannedServer(server, paths, GOODVIBES_AGENT_SURFACE_ROOT),
        // Absent: the non-spawning unavailable seam. The interactive boot passes the host seam.
        powerSeam: options.powerSeam,
        currentSessionId: options.resolveSessionId ? () => options.resolveSessionId?.({}) ?? null : undefined,
        // The same privacy setting the shell's own notices read; unreadable means metadata only.
        notificationsMetadataOnly: () => readNotificationsMetadataOnly((key) => readAgentHostSetting(configManager, key)),
        // No supervisor restarts the Agent, so a memory tripwire warns instead of exiting.
        tripwireExit: (receipt) => {
          logger.warn('[memory] the Agent keeps running past a memory tripwire; save your work and restart it when convenient', {
            trigger: receipt.trigger,
            rssMb: receipt.rssMb,
            budgetMb: receipt.budgetMb,
          });
        },
        // Consolidation writes the store, so it runs here only while no daemon owns it.
        consolidationTarget: (registry, spine) => gateConsolidationToLocalWriter(registry, spine),
        onConsolidationReceipt: (receipt) => {
          const summary = describeMemoryConsolidationReceipt(receipt);
          if (summary) memoryConsolidationReceiptFeed.push([{ id: receipt.runId, text: summary, at: Date.now() }]);
        },
        busySessionCount: () => hostedSessions.countBusySessions(),
        // The daemon keeps and runs routines; this process catches none up on wake.
        runsRoutines: () => false,
        worktreeRegistry: createDisabledAgentWorktreeRegistry,
        // Automatic snapshots run only in a registered workspace (or with
        // `checkpoints.unregisteredWorkspaces: "guarded"`), checked live at each
        // event so registering mid-launch applies at once. The store sits under
        // this surface's root; the session id is stamped from the live resolver.
        workspaceCheckpoints: (input) => {
          const manager = new WorkspaceCheckpointManager({
            workspaceRoot: input.workspaceRoot,
            ...readCheckpointGuardSettings(input.configManager),
            surface: input.surface,
            runtimeBus: input.runtimeBus,
            automaticSnapshotsAllowed: checkpointsCurrentlyAllowed,
            ...(options.resolveSessionId ? { resolveSessionId: options.resolveSessionId } : {}),
          });
          // Initialised now so the automatic snapshot subscription is live before the first turn ends.
          void manager.init().catch((err) => {
            logger.warn('WorkspaceCheckpointManager.init failed', { error: err instanceof Error ? err.message : String(err) });
          });
          return { manager, currentlyAllowed: checkpointsCurrentlyAllowed, close: () => manager.drain() };
        },
      },
      // The plugin-only catalog: occasions.* and profile.* fall through to the daemon.
      gatewayVerbs: 'product',
      // Triggers are supervised by the host (`/triggers` reads the host's supervisor).
      triggers: 'host',
      // Inbound continuations arrive over the wire dispatch below, not the register.
      continuationRunner: 'product',
      taskGraphReaping: 'never',
      // The Agent's own profile tool reaches the daemon's owner-profile store.
      profileCapture: false,
      automationSurfaceKind: 'service',
      knowledge: 'agent',
      // One live Agent per home: a second copy stops at the claim and names the holder's pid.
      homeSingleWriter: options.homeSingleWriter ?? 'claim',
      // A `type: 'agent'` hook answers "not configured in this runtime" and spawns nothing.
      hookAgentRuns: 'withhold',
      // The repo code index is a terminal app and daemon feature; pairing tokens are a listener's.
      codeIndex: 'on-demand',
      pairingTokens: 'on-demand',
      extras: (base, scope) => {
        const { agentManager, providerRegistry, secretsManager, processRegistry, surface } = base;
        // Inbound continuation dispatch over the wire. Inert until `activate`: an
        // agent with no adopted daemon holds its bound runner and dispatches nothing.
        const sessionDispatch: WireSessionDispatch = createWireSessionDispatch({
          hostedSessionIds: () => hostedSessions.ids(),
          // A continuation dispatched here runs in THIS process, so the daemon's own
          // completion poll can never see it finish; this is how the answer is
          // reported back, and answered into the channel it arrived on.
          readAgentOutcome: (agentId) => readSurfaceAgentOutcome(agentManager.getStatus(agentId)),
        });
        scope.registry.add('inbound session dispatch', () => sessionDispatch.stop());
        // Hand-to-hosting: asked first on every inbound message; with the setting
        // off it answers "not promoted" without a round trip. Read per call.
        const hostedHandoff = createHostedConversationHandoff({
          verbs: daemonVerbs,
          isEnabled: () => configManager.get('hostedSessions.promoteInboundConversations') === true,
          workspaceRoot: () => workingDirectory,
          // No process id: a restarted process must derive the same conversation identity.
          clientId: HOSTED_HANDOFF_CLIENT_ID,
          // Home-scoped: one Agent runs per home.
          store: createHostedHandoffFileStore(shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'hosted-handoff.json')),
          log: logger,
        });
        const researchScreeningLifetime = new AbortController();
        const researchReportSourceOwner = createAgentResearchSourceOwner(configManager, secretsManager, researchScreeningLifetime.signal);
        scope.registry.add('research screening owner', () => researchReportSourceOwner.close());
        // First-party local reads: code-only screening on this machine, nothing sent anywhere.
        const localReadSourceOwner = createClassicProtectedSourceOwner(Object.freeze({
          ownerId: `agent-local-reads-${randomUUID()}`,
          revision: randomUUID(),
          signal: researchScreeningLifetime.signal,
          assertCurrent: () => researchScreeningLifetime.signal.throwIfAborted(),
        }));
        scope.registry.add('local read source owner', () => localReadSourceOwner.close());
        // Installed by the interactive boot only (bootstrap-core.ts); cleared below when they are this graph's.
        const daemonConfigClient: DaemonConfigClient = createDaemonConfigClient(daemonVerbs);
        const daemonCredentialsClient: DaemonCredentialsClient = createDaemonCredentialsClient(daemonVerbs);
        // The grants ledger and capture store are the daemon's; the phone tool reaches them over its verbs.
        const devicesClient: DevicesClient = createDevicesClient(daemonVerbs);
        const contractIntake = createContractIntake({ runner: base.contractRunner, projectRoot: workingDirectory });
        // The approvals list: the daemon's record over `approvals.list`, unioned with
        // the asks this broker still holds, and the reason when the daemon cannot be
        // read. Push replaces the wait between re-reads, not the re-read.
        const approvalsView = createApprovalsView({
          verbs: daemonVerbs,
          localBroker: base.approvalBroker,
          subscribe: async ({ onUpdate, onTerminate }) => {
            const resolved = resolveConnectedHostConnection(connectedHostAccess);
            if ('reason' in resolved) {
              logger.debug('[approvals] no connected host for the approval-update stream; the list keeps re-reading', { reason: resolved.reason });
              return null;
            }
            return await watchApprovalUpdates({ baseUrl: resolved.baseUrl, getAuthToken: () => resolved.token, onUpdate, onTerminate });
          },
        });
        scope.registry.add('approvals view', () => approvalsView.stop());

        // The session spine over this surface's REST transport: live at
        // construction, client-only, never starts the daemon. A down daemon
        // degrades to an offline queue while the local broker keeps rendering.
        const spineResolveConnection = createSpineConnectionResolver(configManager, homeDirectory);
        const daemonReceiptFeed = new AgentDaemonReceiptFeed();
        // The daemon's receipts reach only a `?receipts=peek` read, run once per attach; each is
        // acknowledged by the feed once it is on screen.
        const spineReceiptConsumer = createSessionSpineReceiptConsumer({ resolveConnection: spineResolveConnection, acknowledgeOnRead: false });
        const spineReceiptAcknowledger = createSessionSpineReceiptAcknowledger({ resolveConnection: spineResolveConnection });
        // A daemon too old for a verb this build depends on is told once per attach, in the same feed.
        const daemonBuildGuard = new DaemonBuildGuard({
          floor: AGENT_DAEMON_BUILD_FLOOR,
          onDaemonUpdateRequired: (verdict) => {
            logger.warn('the attached daemon is older than this Agent build requires', { daemonVersion: verdict.daemonVersion, floor: verdict.floor });
            daemonReceiptFeed.push([{ id: `daemon-build-floor:${verdict.floor ?? 'unknown'}`, text: verdict.message, at: Date.now() }]);
          },
        });
        connectedHostRefusal = () => daemonBuildGuard.refusal();
        const mayAdoptDaemonBuild = createDaemonAdoptionGate({
          resolveConnection: spineResolveConnection,
          readStatus: readDaemonStatusPayload,
          guard: daemonBuildGuard,
        });
        const consumeDaemonReceipts = createDaemonReceiptConsumption({
          consumeReceipts: spineReceiptConsumer,
          acknowledgeReceipts: spineReceiptAcknowledger,
          feed: daemonReceiptFeed,
        });
        // A daemon update leaves this process on the build it started with; below
        // the floor the daemon announces, shared-session work pauses and the owner is told.
        const clientBuildGuard = new ClientBuildGuard({
          clientVersion: VERSION,
          onRestartRequired: (verdict) => {
            logger.warn('daemon requires a newer client build; shared-session work is paused', { clientVersion: verdict.clientVersion, floor: verdict.floor });
            daemonReceiptFeed.push([{ id: `client-build-floor:${verdict.floor ?? 'unknown'}`, text: verdict.message, at: Date.now() }]);
          },
        });
        const sessionSpineClient = new SessionSpineClient({
          participant: AGENT_SPINE_PARTICIPANT,
          // Stated: an absent kind is recorded by the broker as a terminal session.
          recordKind: 'agent',
          transport: createSessionSpineRestTransport({ resolveConnection: spineResolveConnection }),
          // Liveness only: a plain /status read that never consumes receipts.
          probe: createSessionSpineRestProbe({
            resolveConnection: spineResolveConnection,
            onDaemonFloor: (floor) => clientBuildGuard.observeFloor(floor),
          }),
          log: logger,
        });
        scope.registry.add('session spine client', () => sessionSpineClient.dispose());
        // An inbound continuation runs here because this process holds the loop;
        // the build-floor check comes first. Held, not null: null reads as
        // consumed, and the message would be lost instead of waiting for a restart.
        sessionDispatch.setContinuationRunner(async ({ task, input, routeBinding }) => {
          if (!clientBuildGuard.maySharedSessionWork()) {
            logger.warn('declined a shared-session continuation: this build is below the daemon floor', {
              sessionId: input.sessionId,
              floor: clientBuildGuard.current().floor,
            });
            return { disposition: 'held', reason: 'this build is below the daemon floor; restart it to process this message' };
          }
          return runHostedContinuation({ task, input, ...(routeBinding ? { routeBinding } : {}) }, {
            hostedHandoff,
            spawn: (spawnInput) => agentManager.spawn(spawnInput),
            spawnDeps: { configReader: configManager, modelCandidates: providerRegistry.listModels() },
            log: logger,
          });
        });
        // The memory spine's wire transport, handed to `memorySpine.activate()` on daemon adoption.
        const memorySpineTransport = createMemorySpineRestTransport({ resolveConnection: spineResolveConnection });

        // The work this process spawned, unioned with the adopted daemon's, local
        // winning on a shared id: what the Activity modal reads.
        const fleetUnion = createAgentFleetUnion({
          local: { nodes: () => processRegistry.query().nodes },
          verbs: daemonVerbs,
        });
        scope.registry.add('fleet union poller', () => fleetUnion.stop());
        // MCP servers start when a tool needs one, never at boot (runtime/mcp-lazy-start.ts).
        const lazyMcp = createLazyMcpRegistry(base.mcpRegistry, shellPaths);

        // Explicit checkpoint creation through the gateway catalog composed over
        // this graph is gated the same way as automatic snapshots: an unregistered
        // workspace is refused with how to register it, never registered on the
        // caller's behalf. Reads and restores stay unrestricted.
        const manager = base.workspaceCheckpointManager;
        const guardedCheckpoints: RuntimeServices['guardedCheckpoints'] = {
          // Read each time: init may move the root to the enclosing repository's top level.
          get workspaceRoot() { return manager.workspaceRoot; },
          resolveRoot: manager.resolveRoot.bind(manager),
          list: manager.list.bind(manager),
          diff: manager.diff.bind(manager),
          restore: manager.restore.bind(manager),
          sessionChanges: manager.sessionChanges.bind(manager),
          create: (opts) => {
            const eligibility = checkpointsRegistration();
            if (!(eligibility.state === 'readable' && eligibility.resolution.status === 'covered') && !checkpointsGuarded()) {
              // Names the real state: not registered, declined, or a register that cannot be read.
              throw new Error(eligibility.state === 'unreadable'
                ? checkpointEligibilityRefusal(eligibility, workingDirectory)
                : `${checkpointEligibilityRefusal(eligibility, workingDirectory)} To register: goodvibes-agent workspaces register --yes`);
            }
            // An explicit create made this launch is stamped with the live session, as automatic ones are.
            const sessionId = opts.sessionId ?? options.resolveSessionId?.({});
            return manager.create(sessionId ? { ...opts, sessionId } : opts);
          },
        };

        // The conversation half of unified rewind, offered rather than served: the
        // daemon asks this process about a session it holds, and a question about
        // one it does not hold is answered `unavailable` with the reason. Started at
        // bootstrap; stores close only after a rewind in flight has finished with them.
        const conversationRewindHost = createConversationRewindHost({
          verbs: daemonVerbs,
          // Undo snapshots beside the sessions, so a rewind can still be undone after a restart.
          port: createSessionConversationRewindPort({ undoDir: join(surface.sessionsDir, 'rewind-undo') }),
          hosts: (sessionId) => hostedSessions.hosts(sessionId),
          label: 'GoodVibes Agent',
          surface,
        });
        let conversationRewindClosing: Promise<void> | undefined;
        const requestConversationRewindStop = (): Promise<void> => conversationRewindClosing ??= conversationRewindHost.stop();
        scope.registry.add('conversation rewind host', () => { void requestConversationRewindStop().catch(() => {}); });
        scope.registry.add('hosted session registry', () => hostedSessions.dispose());
        // The two process-wide routing clients go down with the graph that installed
        // them, and only when the installed client is this graph's own: a second
        // graph in a live process (a bundle export) never installed anything.
        scope.registry.add('daemon settings routing', () => {
          if (agentDaemonCredentialsClient() === daemonCredentialsClient) installAgentDaemonCredentialsClient(null);
          if (agentDaemonConfigClient() === daemonConfigClient) installAgentDaemonConfigClient(null);
        });
        scope.registry.add('conversation rewind drain', () => conversationRewindClosing);

        const close = (): Promise<void> => {
          researchScreeningLifetime.abort();
          void requestConversationRewindStop().catch(() => {});
          return base.close();
        };
        // The main tool registry is composed after this graph (bootstrap-core.ts), so the ledger reads its definitions through this.
        let describeTool: (name: string) => ToolDefinition | undefined = () => undefined;
        const own = {
          keybindingsManager,
          approvalsView,
          // The client shape's dispatch seam; the register automation runs on rides beside it under its own name.
          sessionBroker: sessionDispatch,
          automationSessionRegister: base.sessionBroker,
          permissionPromptRef,
          hostedSessions,
          hostedHandoff,
          guardedCheckpoints,
          daemonVerbs,
          resolveConnectedHost: () => resolveConnectedHostConnection(connectedHostAccess),
          daemonConfigClient,
          daemonCredentialsClient,
          devicesClient,
          conversationRewindHost,
          sessionSpineClient,
          sessionSpine: sessionSpineClient,
          memorySpineClient: base.memorySpine,
          memoryAccess: base.memorySpine,
          memorySpineTransport,
          daemonReceiptFeed,
          consumeDaemonReceipts,
          mayAdoptDaemonBuild,
          memoryConsolidationReceiptFeed,
          fleetUnion,
          researchReportSourceOwner,
          localReadSourceOwner,
          // OS-level terminal focus, fed from 'focus' tokens and read by the approval alerts.
          focusTracker: new FocusTracker(),
          contractIntake,
          executionLedger: new AgentExecutionLedger(runtimeBus, undefined, { describeTool: (name) => describeTool(name) }),
          bindToolDefinitions: (describe: (name: string) => ToolDefinition | undefined): void => { describeTool = describe; },
          mcpRegistry: lazyMcp.registry,
          close,
          dispose: (): void => { void close().catch(() => {}); },
        };
        return {
          ...own,
          // This graph as the platform's daemon-grade shape, for the platform entry
          // points that take it whole: the session register in place of the
          // dispatch seam, every other member this graph's own (those opened on
          // demand stay unopened until read).
          asDaemonGradeView: (): PlatformRuntimeServices => withMembers(withMembers(base, own), { sessionBroker: base.sessionBroker }),
        };
      },
    });
  } catch (error) {
    // The graph's own scope released what it had started; the registry built above is this function's.
    hostedSessions.dispose();
    throw error;
  }
}
