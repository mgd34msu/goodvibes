/**
 * The narrow services the daemon hands the capabilities that run there, built
 * from the daemon's own stores. Each capability reads only the ones it names.
 *
 *  - hooks: the hook API over the caller's project's hooks file: a workbench
 *    of its own over that project's file, applied to nothing here: the turns
 *    in that project (a program's, or the daemon's own for that project) read
 *    the changed file before their next hook fires. The daemon's own folder is
 *    no project and holds no hooks file.
 *  - secrets: "All your projects" is the daemon's store, which every program
 *    on this machine reads first; "This project" is the asking program's
 *    project store.
 *  - memory: the one memory store.
 *  - hooks.trace / hooks.record: the hook trace (hooks/trace.ts), one file
 *    per daemon, the daemon's own runs added as they happen.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { noteListChanged } from '../runtime/list-changes.js';
import { WorkspaceTrustManager, workspaceTrustOwnerOf } from '../runtime/workspace-trust.js';
import { createShellPathService } from '../runtime/shell-paths.js';
import type { SecretsView } from './builtin/secrets.js';
import { ConfigManager } from '../config/manager.js';
import { PROGRAM_HOST_SETTINGS, TERMINAL_PROGRAM_DEFAULTS } from '../runtime/program-host-settings.js';
import { SecretsManager } from '../config/secrets.js';
import { isDaemonNeededSecretKey } from '../config/credential-scope-registry.js';
import { SkillLibrary } from '../skills/library.js';
import { ProfileManager } from '../profiles/manager.js';
import { callerPathOf } from './path-inputs.js';
import { describePermissionModeInForce } from '../permissions/decision-model-readiness.js';
import { carriedPolicyNote } from '../runtime/permissions/policy-config-loader.js';
import { createHookApi, createHookApiDispatcher, type HookApi } from '../hooks/hook-api.js';
import { listHookPointContracts } from '../hooks/contracts.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import { HookWorkbench } from '../hooks/workbench.js';
import type { HookActivityTracker } from '../hooks/activity.js';
import { HookTraceStore, hookTraceRecordOf } from '../hooks/trace.js';
import type { WebSearchCapabilityServices } from './builtin/tools.js';
import { createMcpCapabilityServices, type McpServiceSources } from './mcp-services.js';
import { loadMcpEffectiveConfig, MCP_DEFAULT_TRUST_MODE } from '../mcp/config.js';
import { requireCallerProject } from './caller-project.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { projectSettingsInForce } from '../config/project-view.js';
import { noProjectFacts, noProjectRefusal } from '../workspace/caller-project.js';
import { createPluginCapabilityServices, type PluginServiceSources } from './plugins-services.js';
import { controlPlaneStorePath } from '../control-plane/control-plane-store-paths.js';
import { DAEMON_STATE_SURFACE_ROOT } from '../daemon/lifecycle-marker.js';
import { resolveGoodVibesTreeDirectory } from '../config/goodvibes-home.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { createKnowledgeApi, createMemoryApi, type KnowledgeApi } from '../knowledge/knowledge-api.js';
import { TemplateManager } from '../templates/manager.js';
import type { MemoryRegistry } from '../state/memory-registry.js';
import type { DaemonCapabilityServices } from './builtin/index.js';
import type { AgentStoreRunner } from './builtin/agent-stores.js';
import type { ModelComparisonRunner } from './builtin/compare.js';
import { mailboxServices } from './builtin/messages.js';
import type { NotifyCapabilityServices } from './builtin/notify.js';
import type { GoogleCapabilityServices } from './builtin/google.js';
import type { ChannelSendCapabilityServices } from './builtin/channel-send.js';
import type { CalendarHereCapabilityServices } from './builtin/calendar.js';
import { daemonLocalCalendar } from '../calendar/local-calendar.js';
import { daemonCalendarAccounts } from '../calendar/daemon-accounts.js';
import { revealOrNull } from '../security/secret.js';
import { resolveSecretWriteScope } from '../config/secrets.js';
import { unreadableSecretStore, type StoredSecretReader } from '../config/secret-store-unreadable.js';
import { persistSecretBackedConfigValue } from '../config/secret-backed-config.js';
import { getProcessUntrustedContentLedger } from '../security/untrusted-content.js';
import { daemonGoogleWork } from '../google/daemon-work.js';
import { EmailService } from '../email/email-service.js';
import { withSurfaceEmailConfig } from '../email/surface-config.js';
import { describeSenderClaimNeutrally } from '../email/sender-claim.js';
import { nodeEmailTransport } from '../email/node.js';
import { NOTIFICATIONS_METADATA_ONLY_KEY, readNotificationsMetadataOnly } from '../runtime/notification-privacy.js';
import type { ConfigKey } from '../config/schema-types.js';
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '../config/goodvibes-home.js';
import type { RemoteRunnerRegistry } from '../runtime/remote/runner-registry.js';
import type { RemoteSupervisor } from '../runtime/remote/supervisor.js';
import { daemonRemoteRunners } from '../runtime/remote/daemon-runners.js';
import type { RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { JudgmentServices } from '../runtime/judgment-services.js';
import type { PermissionManager } from '../permissions/manager.js';
import { CapabilityRefusal, type CapabilityCaller } from './types.js';
import type { RemoteCapabilityServices } from './builtin/remote.js';
import { createModelsCapabilityServices, type ModelsServiceSources } from './models-services.js';
import { createSupportCapabilityServices } from './support-services.js';
import { persistProviders, scan } from '../discovery/scanner.js';
import { loadPersistedProviders } from '../discovery/persisted-providers.js';
import { NETWORK_SCAN_SURFACE_ROOT } from '../discovery/network-scan.js';
import type { NetworkScanCapabilityServices } from './builtin/network-scan.js';

export interface DaemonCapabilityServiceSources {
  readonly configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory' | 'setDynamic' | 'validateDynamic' | 'getCategory' | 'mergeCategory'>;
  /** The daemon's sessions: a runner it starts is registered as a session titled by its task (builtin/remote.ts). */
  readonly sessionBroker?: Pick<import('../control-plane/session-broker.js').SharedSessionBroker, 'register'> | undefined;
  /** The daemon's webhook notifier (builtin/notify.ts); absent, the notify capabilities say so. */
  readonly webhookNotifier?: NotifyCapabilityServices['notify']['notifier'] | undefined;
  /** The daemon's channel router and the sends it keeps receipts of (builtin/channel-send.ts); absent, a send says so. */
  readonly channelSends?: ChannelSendCapabilityServices['channelSends'] | undefined;
  readonly hookDispatcher: HookDispatcher;
  readonly secretsManager: SecretsManager;
  readonly memoryRegistry: MemoryRegistry;
  /** The daemon's own hook runs, added to the hook trace as they happen. */
  readonly hookActivityTracker?: Pick<HookActivityTracker, 'onRecord'> | undefined;
  /** Where the daemon keeps its state (the hook trace's file). */
  readonly shellPaths?: Pick<ShellPathService, 'resolveUserPath'> | undefined;
  /** The daemon's web search service, the one `web_search.query` runs (builtin/tools.ts). */
  readonly webSearchService?: WebSearchCapabilityServices['webSearch'];
  /** The daemon's own MCP registry: its folder's tool servers, connected (builtin/mcp.ts, mcp-services.ts). */
  readonly mcpRegistry?: McpServiceSources['mcpRegistry'];
  /** The daemon's own plugin manager (builtin/plugins.ts, plugins-services.ts). */
  readonly pluginManager?: PluginServiceSources['pluginManager'];
  /** The Agent's own stores (notes, personas, routines, drafts, artifacts), run by the daemon (builtin/agent-stores.ts). */
  readonly agentStores?: AgentStoreRunner | undefined;
  /** Work and agents (builtin/media-collect.ts): the daemon's artifact store, which a collected image or video is read from. */
  readonly artifactStore?: {
    readContent(id: string): Promise<{ readonly buffer: Buffer }>;
    /** Memory and knowledge (builtin/knowledge.ts): a file's content sent by the program that read it is kept here, then added. */
    create?(input: { readonly dataBase64: string; readonly filename: string; readonly acquisitionMode: 'inline-data'; readonly fetchMode: 'not-applicable' }): Promise<{ readonly id: string }>;
    delete?(id: string): unknown;
  } | undefined;
  /** Models and providers: blind model comparisons, run by the daemon (builtin/compare.ts). */
  readonly modelComparisons?: ModelComparisonRunner | undefined;
  /**
   * The daemon's remote runners (builtin/remote.ts, runtime/remote/daemon-runners.ts): its runner registry and
   * supervisor, the store and bus a runner reports to, the agent manager a local rerun starts in, and the gate a
   * runner's asks go through. Named as the runtime graph names them; absent, the remote capabilities say so.
   */
  readonly remoteRunnerRegistry?: RemoteRunnerRegistry | undefined;
  readonly remoteSupervisor?: RemoteSupervisor | undefined;
  readonly runtimeStore?: RuntimeStore | undefined;
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly agentManager?: AgentManager | undefined;
  readonly judgment?: Pick<JudgmentServices, 'port'> | undefined;
  readonly permissionManager?: PermissionManager | undefined;
  /** The home folder the daemon's own home is under (`~/.goodvibes/daemon` holds the runner file). */
  readonly homeDirectory?: string | undefined;
  /** The daemon's machine-group verbs (builtin/cluster.ts), the ones its `/api/cluster/*` routes call; null where it runs no group. */
  readonly clusterVerbs?: (() => import('../daemon/http/cluster-group-routes.js').ClusterGroupVerbs | null) | undefined;
  /** The daemon's one owner inbox (builtin/waiting.ts); absent where this service set was built without it. */
  readonly ownerInbox?: Pick<import('../control-plane/owner-inbox.js').OwnerInbox, 'list' | 'find'> | undefined;
  /** Permissions and safety (builtin/permissions.ts, security.ts): the one permission rule store, the token audit, the daemon's own folder's trust. */
  readonly userPermissionRuleStore?: Pick<import('../permissions/user-rule-store.js').UserPermissionRuleStore, 'add' | 'list'> | undefined;
  readonly tokenAuditor?: Pick<import('../security/token-audit.js').ApiTokenAuditor, 'auditAll'> | undefined;
  readonly workspaceTrustManager?: import('../runtime/workspace-trust.js').WorkspaceTrustManager | undefined;
  /** Permissions and safety (builtin/security-review.ts): the daemon's policy state, which writes the one activation record. */
  readonly policyRuntimeState?: import('../runtime/permissions/policy-runtime.js').PolicyRuntimeState | undefined;
  /** Memory and knowledge (builtin/knowledge.ts): the daemon's one knowledge store. */
  readonly knowledgeService?: import('../knowledge/service.js').KnowledgeService | undefined;
  /** Models and providers (builtin/models.ts, services.ts): the daemon's provider stack, sign-ins and services file (models-services.ts). */
  readonly providerRegistry?: ModelsServiceSources['providerRegistry'];
  readonly providerOptimizer?: ModelsServiceSources['providerOptimizer'];
  readonly favoritesStore?: ModelsServiceSources['favoritesStore'];
  readonly benchmarkStore?: ModelsServiceSources['benchmarkStore'];
  readonly subscriptionManager?: ModelsServiceSources['subscriptionManager'];
  readonly serviceRegistry?: ModelsServiceSources['serviceRegistry'];
  readonly mediaProviders?: ModelsServiceSources['mediaProviders'];
  /** Work (builtin/work.ts): the daemon's plans before they run, where a proposed piece of work waits. */
  readonly workPlans?: Pick<import('../workflow/work-ledger/work-plans.js').WorkPlans, 'propose' | 'noteCause'> | undefined;
  /** A project's own plans before they run (the daemon keeps Work per project), made on its first use. */
  readonly workPlansFor?: ((project: string) => Promise<Pick<import('../workflow/work-ledger/work-plans.js').WorkPlans, 'propose' | 'noteCause'>>) | undefined;
}

/** Something this daemon was composed without: every use of it says so, in one sentence. */
function absent<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() { throw new CapabilityRefusal(`This daemon was started without ${what}; nothing was read or changed.`, undefined, 'UNAVAILABLE'); },
  });
}

/** Memory and knowledge (builtin/memory.ts, knowledge.ts, templates.ts): the copies of memory, the one knowledge store, the template files. */
function memoryAndKnowledgeServices(sources: DaemonCapabilityServiceSources): Pick<DaemonCapabilityServices, 'memoryCopies' | 'knowledge' | 'knowledgeAsk' | 'knowledgeFiles' | 'templates'> {
  const knowledgeService = sources.knowledgeService;
  const homeDirectory = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome();
  const store = sources.artifactStore;
  return {
    // A file's content sent from the machine it is on, kept as an artifact so it is added as a saved artifact is.
    ...(store?.create ? { knowledgeFiles: {
      async keep(input: { readonly bytes: Buffer; readonly filename: string }) {
        const saved = await store.create!({ dataBase64: input.bytes.toString('base64'), filename: input.filename, acquisitionMode: 'inline-data', fetchMode: 'not-applicable' });
        return { artifactId: saved.id, discard: () => { try { store.delete?.(saved.id); } catch { /* the store's own sweep retires it */ } } };
      },
    } } : {}),
    memoryCopies: sources.memoryRegistry,
    knowledge: knowledgeService ? createKnowledgeApi(knowledgeService) : absent<KnowledgeApi>('its knowledge store'),
    knowledgeAsk: (input, options) => {
      if (!knowledgeService) throw new CapabilityRefusal('This daemon was started without its knowledge store; nothing was asked.', undefined, 'UNAVAILABLE');
      return knowledgeService.ask(input, options);
    },
    templates: {
      // The caller's project's templates, and the ones every project shares (`~/.goodvibes/templates`). A caller that
      // names no project gets the shared ones only (the home as the root), never the daemon's own folder's.
      forProject: (caller) => new TemplateManager({
        projectRoot: caller.workingDirectory ? resolve(caller.workingDirectory) : homeDirectory,
        homeDirectory,
      }),
    },
  };
}

/** The asking program's view of the secret stores: the daemon's, then its own and its project's (as it reads them). */
function secretsViewFor(sources: DaemonCapabilityServiceSources, caller: CapabilityCaller): SecretsView {
  // A caller that named no folder reads the daemon's own stores. One that named its project reads that project's store
  // (as the terminal app keeps it when no program is named, the store "This project" writes: writerFor below), never
  // the store of the folder the daemon started in.
  if (!caller.workingDirectory) return sources.secretsManager;
  const projectRoot = resolve(caller.workingDirectory);
  return new SecretsManager({ projectRoot, globalHome: sources.secretsManager.getGlobalHome(), surfaceRoot: caller.program ?? 'tui', configManager: sources.configManager });
}

/** One folder trust per folder, on the shared register; the daemon's own folder is the daemon's own manager. */
function folderTrustServices(sources: DaemonCapabilityServiceSources): (directory: string) => WorkspaceTrustManager {
  const folders = new Map<string, WorkspaceTrustManager>();
  return (directory) => {
    // A folder inside a project is under its project's trust (one decision per project).
    const root = workspaceTrustOwnerOf(resolve(directory));
    const own = sources.workspaceTrustManager;
    if (own && resolve(own.workspaceRoot) === root) return own;
    let trust = folders.get(root);
    if (!trust) {
      const homeDirectory = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome();
      // The surface root names only where an earlier build's in-folder trust.json sat (never honored); the daemon's is `tui`.
      trust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory }), surfaceRoot: 'tui' });
      // A few folders at most are decided from one daemon; the oldest is let go past that.
      if (folders.size >= 32) folders.delete(folders.keys().next().value!);
      folders.set(root, trust);
    }
    return trust;
  };
}

/** Told after a write of the safety place's lists (a rule, a secret, a folder's trust), for every screen showing them. */
function safetyChanged(change: 'created' | 'changed' | 'deleted' = 'changed', id?: string): void {
  noteListChanged({ list: 'safety', change, ...(id ? { id } : {}) });
}

/** The daemon's network scan: the decision and the servers kept under the daemon's folder, its providers told what it finds. */
function networkScanServices(sources: DaemonCapabilityServiceSources): NetworkScanCapabilityServices['networkScan'] {
  const homeDirectory = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome();
  const roots = { homeDirectory, surfaceRoot: NETWORK_SCAN_SURFACE_ROOT };
  return {
    host: () => ({
      homeDirectory,
      scan: () => scan(),
      persist: (servers) => persistProviders(roots, servers),
      register: (servers) => sources.providerRegistry?.registerDiscoveredProviders(servers),
    }),
    saved: () => loadPersistedProviders(roots),
  };
}

/** The daemon's runners, when this service set was given what they need. */
function remoteServices(sources: DaemonCapabilityServiceSources): RemoteCapabilityServices['remote'] {
  const { remoteRunnerRegistry, remoteSupervisor, runtimeStore, runtimeBus, agentManager, judgment, permissionManager } = sources;
  return {
    runners() {
      if (!remoteRunnerRegistry || !remoteSupervisor || !runtimeStore || !runtimeBus || !agentManager) {
        throw new CapabilityRefusal('This daemon was started without remote runners, so it holds none.', undefined, 'UNAVAILABLE');
      }
      const configManager = sources.configManager as Partial<Pick<ConfigManager, 'onDidInvalidate'>>;
      return daemonRemoteRunners({
        remoteRunnerRegistry, remoteSupervisor, runtimeStore, runtimeBus, agentManager, hookDispatcher: sources.hookDispatcher,
        permissionHost: () => (judgment && permissionManager && configManager.onDidInvalidate
          ? { port: judgment.port, permissionManager, config: { onDidInvalidate: (listener: () => void) => configManager.onDidInvalidate!(listener) } }
          : undefined),
        daemonHome: resolveGoodVibesDaemonHome(sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome()),
        ...(sources.sessionBroker ? { sessionBroker: sources.sessionBroker } : {}),
      });
    },
    setup: () => ({
      // Always: every program uses the daemon ("Use the background daemon" is retired, config/index.ts resolveDaemonEnabled).
      daemonEnabled: true,
      httpListenerEnabled: Boolean(sources.configManager.get('danger.httpListener' as ConfigKey)),
    }),
  };
}

/** One hook trace per file in this process, however many service sets are built over it. */
const HOOK_TRACES = new Map<string, HookTraceStore>();
/** The dispatchers whose runs are already added to a trace (each once). */
const TRACED = new WeakSet<object>();
const TRACE_STARTED = Date.now().toString(36);
let traceSequence = 0;

/** The hook trace: the daemon's file, its own runs added as they happen. */
function daemonHookTrace(sources: DaemonCapabilityServiceSources): HookTraceStore {
  const path = sources.shellPaths
    ? controlPlaneStorePath(sources.shellPaths, DAEMON_STATE_SURFACE_ROOT, 'hook-trace.json')
    : join(resolveGoodVibesTreeDirectory(), DAEMON_STATE_SURFACE_ROOT, 'control-plane', 'hook-trace.json');
  let store = HOOK_TRACES.get(path);
  if (!store) {
    store = new HookTraceStore(path);
    HOOK_TRACES.set(path, store);
  }
  const tracker = sources.hookActivityTracker;
  if (tracker && !TRACED.has(tracker)) {
    TRACED.add(tracker);
    const kept = store;
    // The daemon's own folder (inside its home) is no project: its own runs are stamped with none.
    const home = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome();
    const facts = noProjectFacts(home, resolveGoodVibesDaemonHome(home));
    tracker.onRecord((record) => {
      const folder = sources.configManager.getWorkingDirectory() ?? undefined;
      const project = folder && !noProjectRefusal(folder, facts) ? resolve(folder) : undefined;
      kept.add([hookTraceRecordOf(record, { id: `daemon:${process.pid}:${TRACE_STARTED}:${++traceSequence}`, program: 'daemon', ...(project ? { project } : {}) })]);
    });
  }
  return store;
}

/**
 * The hook runs of the daemon's own turns in one project (that project's hooks file, fired by its dispatcher), added
 * to the one hook trace stamped with that project, so `hooks.trace` from the project shows them and no other does.
 */
export function traceProjectHookRuns(shellPaths: ShellPathService | undefined, project: string, tracker: Pick<HookActivityTracker, 'onRecord'>): void {
  const path = shellPaths
    ? controlPlaneStorePath(shellPaths, DAEMON_STATE_SURFACE_ROOT, 'hook-trace.json')
    : join(resolveGoodVibesTreeDirectory(), DAEMON_STATE_SURFACE_ROOT, 'control-plane', 'hook-trace.json');
  let store = HOOK_TRACES.get(path);
  if (!store) {
    store = new HookTraceStore(path);
    HOOK_TRACES.set(path, store);
  }
  if (TRACED.has(tracker)) return;
  TRACED.add(tracker);
  const kept = store;
  const folder = resolve(project);
  tracker.onRecord((record) => {
    kept.add([hookTraceRecordOf(record, { id: `daemon:${process.pid}:${TRACE_STARTED}:${++traceSequence}`, program: 'daemon', project: folder })]);
  });
}

/**
 * Tools and extensions (builtin/skills.ts, program-settings.ts): the one skill store as the asking program's
 * turns read it (its project's skill folders and the home's, its own surface folder), its curated catalog, and
 * its own settings and presets, read fresh for each call so a change the program made since is never undone.
 */
function programFilesServices(sources: DaemonCapabilityServiceSources): Pick<DaemonCapabilityServices, 'skills' | 'programSettings'> {
  const config = sources.configManager as DaemonCapabilityServiceSources['configManager'] & Partial<Pick<ConfigManager, 'getHomeDirectory' | 'getDaemonTierPath'>>;
  const goodvibesRoot = (): string => sources.shellPaths?.resolveUserPath() ?? resolveGoodVibesTreeDirectory();
  const homeOf = (): string => config.getHomeDirectory?.() ?? sources.homeDirectory ?? dirname(goodvibesRoot());
  // The caller's project, or none: the daemon's own folder is no project (caller-project.ts).
  const projectOf = (caller: CapabilityCaller): string | undefined => caller.workingDirectory ? resolve(caller.workingDirectory) : undefined;
  const programOf = (caller: CapabilityCaller): 'tui' | 'agent' => caller.program ?? 'tui';
  // A relative path with no project is refused: never placed in the daemon's own folder (capabilities/path-inputs.ts).
  const resolvePath = (caller: CapabilityCaller, path: string): string => callerPathOf(caller, path);
  return {
    skills: {
      library: (caller) => SkillLibrary.forPaths({ workingDirectory: projectOf(caller), goodvibesRoot: goodvibesRoot(), surfaceRoot: programOf(caller) }),
      catalogPaths: (caller) => {
        const project = projectOf(caller) ?? homeOf();
        return {
          cwd: project, homeDir: homeOf(),
          projectCatalogRoot: join(project, '.goodvibes', programOf(caller), 'ecosystem'),
          userCatalogRoot: join(goodvibesRoot(), programOf(caller), 'ecosystem'),
        };
      },
      resolvePath,
    },
    programSettings: {
      config: (caller) => {
        const daemonTierPath = config.getDaemonTierPath?.() ?? undefined;
        const project = projectOf(caller);
        // The program's own settings files, as that program reads them; the daemon's file for a daemon-owned setting.
        // Its own settings beyond the schema and the defaults it sets are known, so they read and change here as there.
        const manager = new ConfigManager({
          homeDir: homeOf(), ...(project ? { workingDir: project } : {}), surfaceRoot: programOf(caller),
          ...(daemonTierPath ? { daemonTierPath, ownsDaemonTier: true } : {}),
          hostSettings: PROGRAM_HOST_SETTINGS[programOf(caller)],
        });
        for (const [key, value] of TERMINAL_PROGRAM_DEFAULTS) manager.setRuntimeDefault(key as ConfigKey, value as never);
        return manager;
      },
      daemonConfig: config,
      presets: (caller) => new ProfileManager(join(goodvibesRoot(), programOf(caller), 'profiles')),
      resolvePath,
    },
  };
}

/** A dispatcher view that runs nothing: a project's file is fired by the program running that project's turns. */
const DETACHED_DISPATCHER = {
  clearLoaded(): void {},
  loadFromFile(): void {},
  listHooks: () => [],
  getChains: () => [],
};

/**
 * builtin/google.ts: the daemon's one Google connection (google/daemon-work.ts), on its own settings and secret store,
 * announced as the `google` list changing; a consent link nobody is sitting at goes to the owner inbox.
 */
function googleServices(sources: DaemonCapabilityServiceSources): GoogleCapabilityServices['google'] {
  const homeDirectory = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome();
  // The daemon hands its whole owner inbox; this source names only its reads, so its posting is looked for.
  const inbox = sources.ownerInbox as unknown as Partial<Pick<import('../control-plane/owner-inbox.js').OwnerInbox, 'postNow' | 'withdraw'>> | undefined;
  return daemonGoogleWork({
    config: { get: (key) => sources.configManager.get(key as ConfigKey), setDynamic: (key, value) => sources.configManager.setDynamic(key as ConfigKey, value as never) },
    secrets: sources.secretsManager,
    homeDirectory,
    changed: () => noteListChanged({ list: 'google', change: 'changed' }),
    ...(inbox?.postNow && inbox.withdraw ? {
      postConsent: (link: string) => {
        const posted = inbox.postNow!({ kind: 'report', key: 'google-consent', askedBy: 'google', title: 'Approve Google access',
          detail: `Open this link in a browser signed in to the Google account to connect, and approve it (it asks for mail and calendar together):\n${link}` }, 'google');
        const id = posted.item.id;
        return () => { try { inbox.withdraw!(id, 'The Google consent ended.'); } catch { /* answered or gone already */ } };
      },
    } : {}),
  });
}

/**
 * builtin/calendar.ts: the daemon's calendar on this computer (calendar/local-calendar.ts, the same one the calendar
 * methods serve) and its calendar accounts (calendar/daemon-accounts.ts), over its own settings and secret store.
 */
function calendarHereServices(sources: DaemonCapabilityServiceSources): CalendarHereCapabilityServices['calendarHere'] {
  const homeOf = (): string => sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome();
  const secretsManager = sources.secretsManager;
  const secrets = {
    get: async (key: string) => revealOrNull(await secretsManager.get(key), 'dispatch'),
    set: (key: string, value: string) => secretsManager.set(key, value, { scope: resolveSecretWriteScope(key) }),
    delete: (key: string) => secretsManager.delete(key),
    unreadable: (key: string) => unreadableSecretStore(secretsManager as unknown as StoredSecretReader, key, 'the calendar connection'),
  };
  const ledger = getProcessUntrustedContentLedger();
  const changed = (): void => noteListChanged({ list: 'calendar', change: 'changed' });
  const configString = (key: string): string => {
    try { const value = sources.configManager.get(key as ConfigKey); return typeof value === 'string' ? value.trim() : ''; } catch { return ''; }
  };
  // A sign-in link for a run nobody is sitting at goes to the owner inbox, as the Google connection's consent link does.
  const inbox = sources.ownerInbox as unknown as Partial<Pick<import('../control-plane/owner-inbox.js').OwnerInbox, 'postNow' | 'withdraw'>> | undefined;
  return {
    ...(inbox?.postNow && inbox.withdraw ? {
      postSignIn: (title: string, detail: string) => {
        const posted = inbox.postNow!({ kind: 'report', key: 'calendar-sign-in', askedBy: 'calendar', title, detail }, 'calendar');
        const id = posted.item.id;
        return () => { try { inbox.withdraw!(id, 'The calendar sign-in ended.'); } catch { /* answered or gone already */ } };
      },
    } : {}),
    local: () => daemonLocalCalendar(homeOf(), secrets, (ingest) => { ledger.record(ingest); }),
    accounts: () => daemonCalendarAccounts(homeOf(), {
      get: (key) => sources.configManager.get(key as ConfigKey),
      set: (key, value) => {
        sources.configManager.validateDynamic(key as ConfigKey, value);
        sources.configManager.setDynamic(key as ConfigKey, value);
      },
      storeClientSecret: async (configKey, value) => {
        await persistSecretBackedConfigValue(sources.configManager as unknown as Parameters<typeof persistSecretBackedConfigValue>[0], secretsManager, configKey as ConfigKey, value);
      },
      secrets,
      changed,
    }),
    caldavSet: () => configString('surfaces.calendar.caldavUrl').length > 0 && configString('surfaces.calendar.caldavUser').length > 0,
    resolvePath: (caller, path) => callerPathOf(caller, path),
    changed,
  };
}

/** builtin/notify.ts: the daemon's list of webhook addresses as stored, written back to its settings and handed to its notifier. */
function notifyServices(sources: DaemonCapabilityServiceSources): NotifyCapabilityServices['notify'] {
  const notifier = (): NotifyCapabilityServices['notify']['notifier'] => {
    if (!sources.webhookNotifier) throw new CapabilityRefusal('This daemon was started without its notifier; nothing was sent or changed.', undefined, 'UNAVAILABLE');
    return sources.webhookNotifier;
  };
  return {
    addresses: () => {
      const stored = sources.configManager.getCategory('notifications').webhookUrls;
      return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : [];
    },
    keep: (addresses) => {
      sources.configManager.mergeCategory('notifications', { webhookUrls: [...addresses] });
      sources.webhookNotifier?.setUrls([...addresses]);
    },
    secrets: sources.secretsManager,
    get notifier() { return notifier(); },
    // The same reading the daemon's notifier makes at each delivery (runtime-graph.ts).
    metadataOnly: () => readNotificationsMetadataOnly(() => sources.configManager.get(NOTIFICATIONS_METADATA_ONLY_KEY as ConfigKey)),
  };
}

export function createDaemonCapabilityServices(sources: DaemonCapabilityServiceSources): DaemonCapabilityServices {
  const projects = new Map<string, HookApi>();
  const hooksFileOf = (directory: string): string => resolve(directory, String(sources.configManager.get('tools.hooksFile')));
  const hookTrace = daemonHookTrace(sources);
  // The asking project's plans before they run; a host with one set and no projects (a test's) answers with that set.
  const workPlansOf = async (project: string | undefined): Promise<Pick<import('../workflow/work-ledger/work-plans.js').WorkPlans, 'propose' | 'noteCause'>> => {
    if (sources.workPlansFor) return sources.workPlansFor(requireCallerProject(project, 'a piece of work'));
    return sources.workPlans!;
  };
  return {
    // Tools and extensions: the daemon's web search (builtin/tools.ts) and the projects' MCP config files (builtin/mcp.ts).
    ...(sources.webSearchService ? { webSearch: sources.webSearchService } : {}),
    ...createMcpCapabilityServices(sources),
    ...createPluginCapabilityServices(sources),
    // System (builtin/system-setup.ts): the home folder the one setup record is under (`~/.goodvibes/daemon/setup-state.json`).
    setupHome: () => sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome(),
    // System (builtin/system-updates.ts): the daemon's settings and sign-ins an update review names, and where a file goes.
    systemUpdates: {
      get: (key) => sources.configManager.get(key as ConfigKey),
      subscriptionProviders: () => {
        try { return sources.subscriptionManager?.list().map((entry) => entry.provider) ?? []; } catch { return []; }
      },
      resolvePath: (caller, path) => callerPathOf(caller, path),
    },
    hooks: {
      trace: (options) => hookTrace.list(options),
      record: (runs) => hookTrace.add(runs),
      forProject(workingDirectory) {
        const daemonDirectory = sources.configManager.getWorkingDirectory();
        // The caller's project only (caller-project.ts). The daemon's own folder is no project and holds no hooks file:
        // naming it is naming no project.
        const directory = requireCallerProject(workingDirectory, 'the hooks file');
        if (daemonDirectory && directory === projectIdentityOf(daemonDirectory)) {
          throw new CapabilityRefusal('The daemon\'s own folder is not a project and holds no hooks file; nothing was read or changed.',
            'Name the project whose hooks you mean: its folder, as a terminal program in it sends.', 'NO_PROJECT', 422);
        }
        let api = projects.get(directory);
        if (!api) {
          const workbench = new HookWorkbench(DETACHED_DISPATCHER, () => hooksFileOf(directory));
          api = createHookApi({ dispatcher: createHookApiDispatcher(DETACHED_DISPATCHER), workbench, listContracts: () => listHookPointContracts() });
          // A few projects at most are managed from one daemon; the oldest is let go past that.
          if (projects.size >= 32) projects.delete(projects.keys().next().value!);
          projects.set(directory, api);
        }
        return api;
      },
    },
    secrets: {
      writerFor(scope, caller, key) {
        // A key the daemon itself reads has one place, the daemon's store, whatever was asked; the answer says so.
        const daemonHeld = isDaemonNeededSecretKey(key);
        if (scope === 'user' || daemonHeld) {
          return {
            set: (name, value, options) => sources.secretsManager.set(name, value, { ...options, scope: 'daemon' }),
            scope: 'daemon',
            where: daemonHeld
              ? `the daemon's secret store: the daemon itself reads ${key}, so it is kept there for every project`
              : 'the daemon\'s secret store, which every GoodVibes program on this machine reads first',
          };
        }
        // "This project" is the caller's project, never the folder the daemon started in: no folder, nothing kept.
        const projectRoot = caller.workingDirectory ? resolve(caller.workingDirectory) : undefined;
        if (!projectRoot) {
          throw new CapabilityRefusal('Nothing was kept: "This project" needs the project\'s folder, and none was named.',
            'Send it from the project (its folder), or keep it for every project.');
        }
        const program = caller.program ?? 'tui';
        const store = new SecretsManager({
          projectRoot, globalHome: sources.secretsManager.getGlobalHome(), surfaceRoot: program,
          configManager: sources.configManager,
        });
        return {
          set: (key, value, options) => store.set(key, value, options),
          scope: 'project',
          // The project by its folder's name: a whole path is a long unbroken run a screen's outcome line leaves out.
          where: `the secret store of this project (${basename(projectRoot)}) that ${program === 'agent' ? 'the Agent' : 'the terminal app'} reads`,
        };
      },
      viewFor: (caller) => secretsViewFor(sources, caller),
      changed: (key, change) => safetyChanged(change, key),
    },
    memory: createMemoryApi(sources.memoryRegistry),
    ...memoryAndKnowledgeServices(sources),
    ...programFilesServices(sources),
    // The Agent's own stores: the daemon's runner over them, absent where this daemon was composed without it.
    ...(sources.agentStores ? { agentStores: sources.agentStores } : {}),
    // Work and agents (builtin/media-collect.ts): a collected image or video, read to be written into the asking program's project.
    ...(sources.artifactStore ? { artifactContent: async (id: string) => (await sources.artifactStore!.readContent(id)).buffer } : {}),
    // Models and providers: the daemon's model comparison runner (builtin/compare.ts), absent where it was composed without it.
    ...(sources.modelComparisons ? { modelComparisons: sources.modelComparisons } : {}),
    // The daemon's own mailbox settings (`surfaces.email.*`, the daemon's) and its secret store.
    mailbox: {
      ...mailboxServices({
        get: (key) => sources.configManager.get(key as ConfigKey),
        setDynamic: (key, value) => sources.configManager.setDynamic(key as ConfigKey, value),
        validateDynamic: (key, value) => sources.configManager.validateDynamic(key as ConfigKey, value),
      }, sources.secretsManager),
      // "Set up mail" checks the mailbox once with what it set: each half signed in to, nothing read or sent.
      test: () => new EmailService(withSurfaceEmailConfig({
        getConfig: (key: string) => sources.configManager.get(key as ConfigKey),
        secretsManager: { get: (key: string) => sources.secretsManager.get(key) },
        transport: nodeEmailTransport,
        describeSenderClaim: describeSenderClaimNeutrally,
      })).testEach(),
    },
    // A chat channel's own settings (`surfaces.<channel>.*`, the daemon's) and the secret store ("Enter a channel's keys").
    channelKeys: {
      get: (key: string) => sources.configManager.get(key as ConfigKey),
      set: (key: string, value: unknown) => {
        sources.configManager.validateDynamic(key as ConfigKey, value);
        sources.configManager.setDynamic(key as ConfigKey, value);
      },
      storeSecret: async (key: string, value: string) => {
        await persistSecretBackedConfigValue(sources.configManager as unknown as Parameters<typeof persistSecretBackedConfigValue>[0], sources.secretsManager as Parameters<typeof persistSecretBackedConfigValue>[1], key as ConfigKey, value);
      },
    },
    // The daemon's one list of webhook addresses (`notifications.webhookUrls`, the daemon's), its secret store and notifier.
    notify: notifyServices(sources),
    // The calendar on this computer, its feeds and the calendar accounts (builtin/calendar.ts).
    calendarHere: calendarHereServices(sources),
    // The daemon's channel router and the sends it keeps (builtin/channel-send.ts).
    channelSends: sources.channelSends ?? absent<ChannelSendCapabilityServices['channelSends']>('its channel router'),
    // The daemon's one Google connection (builtin/google.ts): connected, checked and disconnected as the daemon's work.
    google: googleServices(sources),
    // The daemon's remote runners (builtin/remote.ts): one holder per registry, made on first use.
    remote: remoteServices(sources),
    // Models and providers (builtin/models.ts, services.ts): the daemon's provider stack, sign-ins and services file.
    ...createModelsCapabilityServices(sources),
    // System (builtin/system-bundles.ts): a program's support bundle, support folder and setup moved to another computer.
    ...createSupportCapabilityServices(sources),
    // The daemon's machine group (builtin/cluster.ts), read on each call: the group runtime is composed after the router.
    cluster: { verbs: () => sources.clusterVerbs?.() ?? null },
    // Devices and network (builtin/network-scan.ts): the one network-scan decision and the daemon's own scan.
    networkScan: networkScanServices(sources),
    // Devices and network (builtin/settings-sync.ts): the daemon's own settings (the asking program's are programSettings).
    settingsSync: { daemon: () => sources.configManager as ConfigManager },
    // The daemon's one owner inbox (builtin/waiting.ts): what waits on the owner, and what was decided for them.
    ...(sources.ownerInbox ? { ownerInbox: sources.ownerInbox } : {}),
    // Work (builtin/work.ts): a piece of work proposed with its plan waits among the daemon's plans before they run.
    // Kept per project: the caller's project's plans when the daemon keeps Work per project, else its one set.
    // A daemon keeps Work per project only (it has none of its own folder): a call naming no project is refused.
    ...(sources.workPlans || sources.workPlansFor ? { workProposals: { propose: async (proposal, project) => (await workPlansOf(project)).propose(proposal) } } : {}),
    // Who caused a piece of work to run, kept on its record in the same project's Work (work-plans.ts `WorkCause`).
    ...(sources.workPlans || sources.workPlansFor ? { workCauses: { note: async (project: string | undefined, workId: string, cause: import('../workflow/work-ledger/work-plans.js').WorkCause, options?: { readonly made?: boolean | undefined }) =>
      (await workPlansOf(project)).noteCause(workId, cause, options) } } : {}),
    // Permissions and safety (builtin/permissions.ts, security.ts): the one rule store, the token audit, folder trust.
    permissionRules: {
      add: (record) => {
        if (!sources.userPermissionRuleStore) throw new CapabilityRefusal('This daemon was started without the permission rule store; no rule was added.', undefined, 'UNAVAILABLE');
        return sources.userPermissionRuleStore.add(record);
      },
      list: () => {
        if (!sources.userPermissionRuleStore) throw new CapabilityRefusal('This daemon was started without the permission rule store; no rule was read.', undefined, 'UNAVAILABLE');
        return sources.userPermissionRuleStore.list();
      },
    },
    security: {
      tokens: {
        auditAll: (now) => {
          if (!sources.tokenAuditor) throw new CapabilityRefusal('This daemon was started without the token audit, so it cannot list the paired devices\' tokens.', undefined, 'UNAVAILABLE');
          return sources.tokenAuditor.auditAll(now);
        },
      },
      folder: folderTrustServices(sources),
      changed: () => safetyChanged(),
    },
    // Permissions and safety (builtin/security-review.ts): the one policy record, the trust summary, the sandbox setting.
    securityReview: securityReviewServices(sources),
  };
}

/**
 * The policy bundles (the daemon's policy state writes the one activation record every program follows), what is
 * trusted, and the sandbox setting (`sandbox.mcpIsolation` on the daemon's settings, which every program follows).
 */
function securityReviewServices(sources: DaemonCapabilityServiceSources): DaemonCapabilityServices['securityReview'] {
  const config = sources.configManager as DaemonCapabilityServiceSources['configManager'] & Partial<Pick<ConfigManager, 'getAll' | 'getControlPlaneConfigDir'>>;
  const pluginServices = createPluginCapabilityServices(sources);
  // The settings in force for the asking project (config/project-view.ts projectSettingsInForce, the reader the
  // permission manager decides that project's calls with); the daemon's own with no project or from its own folder.
  const settingsFor = (caller: CapabilityCaller): typeof config => {
    const folder = caller.workingDirectory?.trim();
    const own = sources.configManager.getWorkingDirectory();
    if (!folder || !(sources.configManager instanceof ConfigManager) || (own && projectIdentityOf(own) === projectIdentityOf(folder))) return config;
    return projectSettingsInForce(sources.configManager, folder);
  };
  return {
    policy: () => {
      if (!sources.policyRuntimeState) throw new CapabilityRefusal('This daemon was started without its policy state; no policy was read or changed.', undefined, 'UNAVAILABLE');
      return sources.policyRuntimeState;
    },
    config: (caller) => {
      const settings = settingsFor(caller);
      if (!settings.getAll) throw new CapabilityRefusal('This daemon cannot read its settings whole for the review; nothing was reviewed.', undefined, 'UNAVAILABLE');
      return settings.getAll();
    },
    // The asking project's tool servers and plugins, never the daemon's own folder's in their place: the daemon's live
    // registry when the project is the daemon's own folder, else the servers the project's MCP files name (as
    // configured: the daemon runs none of them) and the project's plugins.
    mcpServers: (caller) => {
      const project = requireCallerProject(caller.workingDirectory, 'the project\'s tool servers');
      const daemonDirectory = sources.configManager.getWorkingDirectory() ?? undefined;
      if (sources.mcpRegistry && daemonDirectory && projectIdentityOf(daemonDirectory) === project) return sources.mcpRegistry.listServerSecurity();
      const { servers } = loadMcpEffectiveConfig({ workingDirectory: project, homeDirectory: sources.homeDirectory ?? resolveGoodVibesHome() });
      return servers.map(({ server }) => ({
        name: server.name, trustMode: server.trustMode ?? MCP_DEFAULT_TRUST_MODE, role: server.role ?? ('general' as const),
        allowedPaths: server.allowedPaths ?? [], allowedHosts: server.allowedHosts ?? [], schemaFreshness: 'unknown',
      }));
    },
    plugins: (caller) => {
      const project = pluginServices.plugins.forProject(caller.workingDirectory);
      try { return project?.manager.list() ?? []; } catch { return []; }
    },
    serviceNames: () => {
      try { return Object.keys(sources.serviceRegistry?.getAll() ?? {}); } catch { return []; }
    },
    permissionMode: (caller) => describePermissionModeInForce(settingsFor(caller)),
    sandboxConfig: (caller) => {
      const settings = settingsFor(caller);
      return { get: (key) => settings.get(key as ConfigKey) };
    },
    setMcpIsolation: (mode) => { sources.configManager.setDynamic('sandbox.mcpIsolation' as ConfigKey, mode as never); },
    setSandboxEnabled: (on) => { sources.configManager.setDynamic('sandbox.enabled' as ConfigKey, on as never); },
    carriedNote: () => {
      const dir = config.getControlPlaneConfigDir?.();
      return dir ? carriedPolicyNote(dir) : null;
    },
    resolvePath: (caller, path) => callerPathOf(caller, path),
    changed: () => safetyChanged('changed', 'policy'),
  };
}
