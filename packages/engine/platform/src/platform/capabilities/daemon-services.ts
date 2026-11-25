/**
 * The narrow services the daemon hands the capabilities that run there, built
 * from the daemon's own stores. Each capability reads only the ones it names.
 *
 *  - hooks: the hook API over a project's hooks file. The daemon's own
 *    working directory uses the daemon's live workbench and dispatcher (a
 *    change applies to the daemon's turns at once); any other project gets a
 *    workbench of its own over that project's file, applied to nothing here:
 *    the program running turns in that project reads the changed file before
 *    its next hook fires.
 *  - secrets: "All your projects" is the daemon's store, which every program
 *    on this machine reads first; "This project" is the asking program's
 *    project store.
 *  - memory: the one memory store.
 *  - hooks.trace / hooks.record: the hook trace (hooks/trace.ts), one file
 *    per daemon, the daemon's own runs added as they happen.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { noteListChanged } from '../runtime/list-changes.js';
import { WorkspaceTrustManager } from '../runtime/workspace-trust.js';
import { createShellPathService } from '../runtime/shell-paths.js';
import type { SecretsView } from './builtin/secrets.js';
import { ConfigManager } from '../config/manager.js';
import { SecretsManager } from '../config/secrets.js';
import { SkillLibrary } from '../skills/library.js';
import { ProfileManager } from '../profiles/manager.js';
import { resolveCallerPath } from './builtin/skills.js';
import { createHookApi, createHookApiDispatcher, type HookApi } from '../hooks/hook-api.js';
import { listHookPointContracts } from '../hooks/contracts.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import { HookWorkbench } from '../hooks/workbench.js';
import type { HookActivityTracker } from '../hooks/activity.js';
import { HookTraceStore, hookTraceRecordOf } from '../hooks/trace.js';
import type { WebSearchCapabilityServices } from './builtin/tools.js';
import { createMcpCapabilityServices, type McpServiceSources } from './mcp-services.js';
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
import { mailboxServices } from './builtin/messages.js';
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
import { persistProviders, scan } from '../discovery/scanner.js';
import { loadPersistedProviders } from '../discovery/persisted-providers.js';
import { NETWORK_SCAN_SURFACE_ROOT } from '../discovery/network-scan.js';
import type { NetworkScanCapabilityServices } from './builtin/network-scan.js';

export interface DaemonCapabilityServiceSources {
  readonly configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory' | 'setDynamic' | 'validateDynamic'>;
  readonly hookDispatcher: HookDispatcher;
  readonly hookWorkbench: HookWorkbench;
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
  readonly userPermissionRuleStore?: Pick<import('../permissions/user-rule-store.js').UserPermissionRuleStore, 'add'> | undefined;
  readonly tokenAuditor?: Pick<import('../security/token-audit.js').ApiTokenAuditor, 'auditAll'> | undefined;
  readonly workspaceTrustManager?: import('../runtime/workspace-trust.js').WorkspaceTrustManager | undefined;
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
}

/** Something this daemon was composed without: every use of it says so, in one sentence. */
function absent<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() { throw new CapabilityRefusal(`This daemon was started without ${what}; nothing was read or changed.`, undefined, 'UNAVAILABLE'); },
  });
}

/** Memory and knowledge (builtin/memory.ts, knowledge.ts, templates.ts): the copies of memory, the one knowledge store, the template files. */
function memoryAndKnowledgeServices(sources: DaemonCapabilityServiceSources): Pick<DaemonCapabilityServices, 'memoryCopies' | 'knowledge' | 'knowledgeAsk' | 'templates'> {
  const knowledgeService = sources.knowledgeService;
  const homeDirectory = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? resolveGoodVibesHome();
  return {
    memoryCopies: sources.memoryRegistry,
    knowledge: knowledgeService ? createKnowledgeApi(knowledgeService) : absent<KnowledgeApi>('its knowledge store'),
    knowledgeAsk: (input, options) => {
      if (!knowledgeService) throw new CapabilityRefusal('This daemon was started without its knowledge store; nothing was asked.', undefined, 'UNAVAILABLE');
      return knowledgeService.ask(input, options);
    },
    templates: {
      // The caller's project's templates, and the ones every project shares (`~/.goodvibes/templates`).
      forProject: (caller) => new TemplateManager({
        projectRoot: caller.workingDirectory ? resolve(caller.workingDirectory) : sources.configManager.getWorkingDirectory() ?? homeDirectory,
        homeDirectory,
      }),
    },
  };
}

/** The asking program's view of the secret stores: the daemon's, then its own and its project's (as it reads them). */
function secretsViewFor(sources: DaemonCapabilityServiceSources, caller: CapabilityCaller): SecretsView {
  if (!caller.program) return sources.secretsManager;
  const projectRoot = caller.workingDirectory ? resolve(caller.workingDirectory) : sources.configManager.getWorkingDirectory() ?? process.cwd();
  return new SecretsManager({ projectRoot, globalHome: sources.secretsManager.getGlobalHome(), surfaceRoot: caller.program, configManager: sources.configManager });
}

/** One folder trust per folder, on the shared register; the daemon's own folder is the daemon's own manager. */
function folderTrustServices(sources: DaemonCapabilityServiceSources): (directory: string) => WorkspaceTrustManager {
  const folders = new Map<string, WorkspaceTrustManager>();
  return (directory) => {
    const root = resolve(directory);
    const own = sources.workspaceTrustManager;
    if (own && resolve(own.workspaceRoot) === root) return own;
    let trust = folders.get(root);
    if (!trust) {
      const homeDirectory = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? dirname(resolveGoodVibesHome());
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
  const homeDirectory = sources.homeDirectory ?? (sources.shellPaths as Partial<Pick<ShellPathService, 'homeDirectory'>> | undefined)?.homeDirectory ?? dirname(resolveGoodVibesHome());
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
      });
    },
    setup: () => ({
      // `daemon.enabled` governs, on unless set to false (config/index.ts resolveDaemonEnabled).
      daemonEnabled: sources.configManager.get('daemon.enabled' as ConfigKey) !== false,
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
    tracker.onRecord((record) => {
      const project = sources.configManager.getWorkingDirectory();
      kept.add([hookTraceRecordOf(record, { id: `daemon:${process.pid}:${TRACE_STARTED}:${++traceSequence}`, program: 'daemon', ...(project ? { project: resolve(project) } : {}) })]);
    });
  }
  return store;
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
  const projectOf = (caller: CapabilityCaller): string | undefined => caller.workingDirectory ? resolve(caller.workingDirectory) : config.getWorkingDirectory() ?? undefined;
  const programOf = (caller: CapabilityCaller): 'tui' | 'agent' => caller.program ?? 'tui';
  const resolvePath = (caller: CapabilityCaller, path: string): string => resolveCallerPath(projectOf(caller) ?? homeOf(), path);
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
        return new ConfigManager({
          homeDir: homeOf(), ...(project ? { workingDir: project } : {}), surfaceRoot: programOf(caller),
          ...(daemonTierPath ? { daemonTierPath, ownsDaemonTier: true } : {}),
        });
      },
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

export function createDaemonCapabilityServices(sources: DaemonCapabilityServiceSources): DaemonCapabilityServices {
  const own = createHookApi({
    dispatcher: createHookApiDispatcher(sources.hookDispatcher),
    workbench: sources.hookWorkbench,
    listContracts: () => listHookPointContracts(),
  });
  const projects = new Map<string, HookApi>();
  const hooksFileOf = (directory: string): string => resolve(directory, String(sources.configManager.get('tools.hooksFile')));
  const hookTrace = daemonHookTrace(sources);
  return {
    // Tools and extensions: the daemon's web search (builtin/tools.ts) and the projects' MCP config files (builtin/mcp.ts).
    ...(sources.webSearchService ? { webSearch: sources.webSearchService } : {}),
    ...createMcpCapabilityServices(sources),
    ...createPluginCapabilityServices(sources),
    hooks: {
      trace: (options) => hookTrace.list(options),
      record: (runs) => hookTrace.add(runs),
      forProject(workingDirectory) {
        const daemonDirectory = sources.configManager.getWorkingDirectory();
        if (!workingDirectory || (daemonDirectory && resolve(workingDirectory) === resolve(daemonDirectory))) return own;
        const directory = resolve(workingDirectory);
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
      writerFor(scope, caller) {
        if (scope === 'user') {
          return {
            set: (key, value, options) => sources.secretsManager.set(key, value, options),
            scope: 'daemon',
            where: 'the daemon\'s secret store, which every GoodVibes program on this machine reads first',
          };
        }
        const projectRoot = caller.workingDirectory ? resolve(caller.workingDirectory) : sources.configManager.getWorkingDirectory();
        if (!projectRoot) throw new Error('no project folder was given for a project secret');
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
    // The daemon's own mailbox settings (`surfaces.email.*`, the daemon's) and its secret store.
    mailbox: mailboxServices({
      get: (key) => sources.configManager.get(key as ConfigKey),
      setDynamic: (key, value) => sources.configManager.setDynamic(key as ConfigKey, value),
      validateDynamic: (key, value) => sources.configManager.validateDynamic(key as ConfigKey, value),
    }, sources.secretsManager),
    // The daemon's remote runners (builtin/remote.ts): one holder per registry, made on first use.
    remote: remoteServices(sources),
    // Models and providers (builtin/models.ts, services.ts): the daemon's provider stack, sign-ins and services file.
    ...createModelsCapabilityServices(sources),
    // The daemon's machine group (builtin/cluster.ts), read on each call: the group runtime is composed after the router.
    cluster: { verbs: () => sources.clusterVerbs?.() ?? null },
    // Devices and network (builtin/network-scan.ts): the one network-scan decision and the daemon's own scan.
    networkScan: networkScanServices(sources),
    // Devices and network (builtin/settings-sync.ts): the daemon's own settings (the asking program's are programSettings).
    settingsSync: { daemon: () => sources.configManager as ConfigManager },
    // The daemon's one owner inbox (builtin/waiting.ts): what waits on the owner, and what was decided for him.
    ...(sources.ownerInbox ? { ownerInbox: sources.ownerInbox } : {}),
    // Permissions and safety (builtin/permissions.ts, security.ts): the one rule store, the token audit, folder trust.
    permissionRules: {
      add: (record) => {
        if (!sources.userPermissionRuleStore) throw new CapabilityRefusal('This daemon was started without the permission rule store; no rule was added.', undefined, 'UNAVAILABLE');
        return sources.userPermissionRuleStore.add(record);
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
  };
}
