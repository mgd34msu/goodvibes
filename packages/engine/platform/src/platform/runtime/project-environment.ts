/**
 * project-environment.ts, the ONE builder of a project's environment, used by every host that runs turns in a project:
 * the daemon for each project its turns work in (products/daemon runtime/project-turn-facilities.ts), a terminal program
 * and the daemon's own folder (runtime-graph.ts), and a program-shaped composition with no turns of its own
 * (client-services.ts). A daemon-hosted session takes the project's from the daemon (hosted-session-composition.ts).
 *
 * What a project's environment is, built here and nowhere else:
 *  - its hooks: the project's hooks file (at the project's root, also for a folder below it), loaded into the host's
 *    dispatcher once the owner trusts the folder (held until then, applied when he does);
 *  - its tool servers: the project's MCP files and the owner's own, started in `folder` (the project, or a captured copy
 *    of it a step of planned work runs in), in sandbox sessions rooted there, the project's files held until the owner
 *    trusts the folder, every call decided by the host's permission owner for the project;
 *  - where its long tool output is kept, and its changed-files record.
 *
 * Nothing here starts a server or reads a file until asked: `toolServers.connect()` starts the servers, `hooks.load()`
 * reads the hooks file. `release()` undoes what was built (trust watches, servers).
 */
import { resolve } from 'node:path';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import { HookWorkbench, HooksFileAwaitingTrustError } from '../hooks/workbench.js';
import { McpRegistry } from '../mcp/registry.js';
import { createMcpAutonomousElicitationHandler, type McpPersonElicitation } from '../mcp/elicitation-autonomous.js';
import type { ExternalPermissionHost } from '../permissions/external-request.js';
import { decideInProject } from '../permissions/call-project.js';
import { SessionChangeTracker } from '../sessions/change-tracker.js';
import { FileWatcher } from '../state/file-watcher.js';
import { ProjectIndex } from '../state/project-index.js';
import { OverflowHandler, type OverflowHandlerConfig } from '../tools/shared/overflow.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from './events/index.js';
import { SandboxSessionRegistry } from './sandbox/session-registry.js';
import { repositoryFileGate, type RepositoryFileGate, type RepositoryTrust } from './workspace-trust.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The project's hooks: its hooks file in the host's dispatcher. */
export interface ProjectHooks {
  readonly workbench: HookWorkbench;
  /** Reads the hooks file into the dispatcher (held while the folder is not trusted: resolves, applied on trust). */
  load(): Promise<void>;
  release(): void;
}

/** The project's tool servers. */
export interface ProjectToolServers {
  readonly mcpRegistry: McpRegistry;
  readonly sandboxSessions: SandboxSessionRegistry;
  /**
   * Who decides a server's calls and how a server's question is answered: the host's permission owner, for `project`
   * when given (a call made by any turn is decided for this project, its rules, trust and answers), with `person`
   * asked a question the call's own facts cannot answer when someone is at the host's screen.
   */
  bindPermissions(host: ExternalPermissionHost, options?: { readonly project?: string | undefined; readonly person?: McpPersonElicitation | undefined }): void;
  /** Starts the servers (in `folder`); a failure is logged and leaves the turns without them. */
  connect(): Promise<void>;
  release(): Promise<void>;
}

export interface ProjectEnvironment {
  readonly projectRoot: string;
  readonly hooks: ProjectHooks;
  readonly toolServers?: ProjectToolServers | undefined;
  readonly overflowHandler: OverflowHandler;
  readonly changeTracker: SessionChangeTracker;
  release(): Promise<void>;
}

export interface ProjectHooksOptions {
  /** The host's dispatcher the project's hooks file is loaded into. */
  readonly dispatcher: HookDispatcher;
  /** A folder in the project: the hooks file is read at the project's root. */
  readonly folder: string;
  /** The hooks file, relative to the project (`tools.hooksFile`), read each time it is loaded. */
  readonly hooksFile: () => string;
  /** The gate the hooks file waits on (the owner's trust of the folder); absent, none. */
  readonly gate?: RepositoryFileGate | undefined;
}

export function createProjectHooks(options: ProjectHooksOptions): ProjectHooks {
  const root = projectIdentityOf(options.folder);
  const workbench = new HookWorkbench(options.dispatcher, () => resolve(root, options.hooksFile()));
  const unbind = options.gate ? workbench.bindTrustGate(options.gate) : () => {};
  return {
    workbench,
    load: () => workbench.loadAndApplyManagedHooks().catch((error: unknown) => {
      if (error instanceof HooksFileAwaitingTrustError) return;
      logger.warn('[project] the project\'s hooks file was not loaded; its turns run without its hooks', { project: root, error: summarizeError(error) });
    }),
    release: () => { try { unbind(); } catch { /* the trust watch ends with its host */ } },
  };
}

export interface ProjectToolServersOptions {
  /** Where the servers start and their files are read: the project's folder, or a captured copy of it. */
  readonly folder: string;
  readonly homeDirectory: string;
  /** The shared `sandbox.*` settings a server is contained by. */
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  /** Fires a server call's tool hooks (the project's). */
  readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;
  /** The gate the project's server files wait on; absent, none. */
  readonly gate?: RepositoryFileGate | undefined;
  /** The host's own sandbox sessions when it has them (a program's); absent, new ones rooted in `folder`. */
  readonly sandboxSessions?: SandboxSessionRegistry | undefined;
}

export function createProjectToolServers(options: ProjectToolServersOptions): ProjectToolServers {
  const sandboxSessions = options.sandboxSessions ?? new SandboxSessionRegistry(options.folder);
  const registry = new McpRegistry({ hookDispatcher: options.hookDispatcher, sandboxSessions });
  registry.setRuntimeBus(options.runtimeBus);
  // The SAME sandbox registry the session registry owns, so a call confined by one is confined by the other.
  registry.setSandboxRuntime(options.configManager, sandboxSessions);
  const unbind = options.gate ? registry.bindRepositoryTrust(options.gate) : () => {};
  const roots = { workingDirectory: options.folder, homeDirectory: options.homeDirectory };
  registry.setWorkspaceRoots(roots);
  return {
    mcpRegistry: registry,
    sandboxSessions,
    bindPermissions(host, bind = {}) {
      const owner = host.permissionManager;
      const project = bind.project;
      const decided: ExternalPermissionHost = project === undefined ? host : {
        ...host,
        permissionManager: {
          admitAutonomous: (...args) => decideInProject(project, () => owner.admitAutonomous(...args)),
          ...(owner.retireAutonomousSource ? { retireAutonomousSource: (...args: Parameters<NonNullable<typeof owner.retireAutonomousSource>>) => decideInProject(project, () => owner.retireAutonomousSource!(...args)) } : {}),
        },
      };
      registry.setPermissionHost(decided);
      registry.setElicitationHandler(createMcpAutonomousElicitationHandler(decided, bind.person));
    },
    connect: () => registry.connectAll(roots).catch((error: unknown) => {
      logger.warn('[project] the project\'s tool servers were not started; its turns have none until the files are fixed', { folder: options.folder, error: summarizeError(error) });
    }),
    release: async () => {
      try { unbind(); } catch { /* the trust watch ends with its host */ }
      await registry.disconnectAll().catch((error: unknown) => {
        logger.warn('[project] the project\'s tool servers did not stop cleanly', { folder: options.folder, error: summarizeError(error) });
      });
    },
  };
}

export interface ProjectEnvironmentOptions {
  /** A folder in the project (the hooks file and tool-server files are the project root's). */
  readonly folder: string;
  readonly homeDirectory: string;
  /** The owner's trust of the project's folder: the project's hooks and server files wait on it. Null: nothing waits. */
  readonly trust: RepositoryTrust | null;
  /** The host's dispatcher (a program's own, or one the host made for this project). */
  readonly hookDispatcher: HookDispatcher;
  /** What a tool server's call fires (the project's hooks, maybe waiting on the project's start); default the dispatcher. */
  readonly toolCallHooks?: Pick<HookDispatcher, 'fire'> | undefined;
  readonly hooksFile: () => string;
  /** The project's tool servers; absent, none (a composition that runs no turns of its own). */
  readonly toolServers?: {
    readonly configManager: ConfigManager;
    readonly runtimeBus: RuntimeEventBus;
    readonly sandboxSessions?: SandboxSessionRegistry | undefined;
  } | undefined;
  /** `baseDir`: where long output is kept when not at the project (the daemon's records, never its own folder). */
  readonly overflow?: Pick<OverflowHandlerConfig, 'featureFlags' | 'spillBackend' | 'baseDir'> | undefined;
  /**
   * Watch the project for files changed outside its turns' tools (an editor, git, a command of the owner's), firing
   * the project's `Change:file:external` hooks through its dispatcher, as a terminal program opened there does: for a
   * host that runs turns in the project without a program of its own there (the daemon). A program watches its own
   * project already (runtime-graph.ts); absent or false, nothing is watched here.
   */
  readonly watchExternalChanges?: boolean | undefined;
}

/** A project's environment, built once by its host. See the module header. */
export function createProjectEnvironment(options: ProjectEnvironmentOptions): ProjectEnvironment {
  const projectRoot = projectIdentityOf(options.folder);
  const gate = options.trust ? repositoryFileGate(options.trust, options.homeDirectory) : undefined;
  const hooks = createProjectHooks({ dispatcher: options.hookDispatcher, folder: projectRoot, hooksFile: options.hooksFile, gate });
  const toolServers = options.toolServers ? createProjectToolServers({
    folder: projectRoot, homeDirectory: options.homeDirectory, configManager: options.toolServers.configManager,
    runtimeBus: options.toolServers.runtimeBus, hookDispatcher: options.toolCallHooks ?? options.hookDispatcher, gate,
    sandboxSessions: options.toolServers.sandboxSessions,
  }) : undefined;
  // Files changed outside the turns' tools: the project's own external-change hooks (the tools' own writes are told
  // apart by state, state/file-watcher.ts noteToolWrites).
  const watchedIndex = options.watchExternalChanges === true ? new ProjectIndex(projectRoot, projectRoot) : undefined;
  const fileWatcher = watchedIndex ? new FileWatcher(watchedIndex, { projectRoot }, options.hookDispatcher) : undefined;
  if (fileWatcher) {
    void fileWatcher.start().catch((error: unknown) => {
      logger.warn('[project] the project\'s files are not watched; its external-change hooks do not fire', { project: projectRoot, error: summarizeError(error) });
    });
  }
  return {
    projectRoot,
    hooks,
    ...(toolServers ? { toolServers } : {}),
    overflowHandler: new OverflowHandler({ baseDir: projectRoot, ...(options.overflow ?? {}) }),
    changeTracker: new SessionChangeTracker(),
    release: async () => {
      fileWatcher?.stop();
      await watchedIndex?.dispose().catch(() => { /* an index that never opened has nothing to close */ });
      hooks.release();
      await toolServers?.release();
    },
  };
}
