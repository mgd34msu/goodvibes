/**
 * The environment of the daemon's own turns in one project: what a terminal conversation in that folder has, built
 * from that project, never from the folder the daemon was started in.
 *
 * - its hooks (the project's hooks file, loaded under the owner's trust of that folder, fired for the daemon's turns
 *   there and recorded in the hook trace as that project's);
 * - its tool servers (the project's MCP files and the owner's own, started in that folder under that folder's trust,
 *   the shared containment setting and the daemon's permission owner deciding for that project);
 * - its checklist (`work_plan`: the plan a terminal program in the folder keeps, in the one shared plan file);
 * - its changed-files record and where its long tool output is kept;
 * - after a turn or run: a checkpoint of the project when its files changed (the project's own checkpoint store,
 *   gated as every automatic checkpoint is; a no-op when nothing changed).
 *
 * Built once per project, on the first turn there, and the same one handed to every later turn: no turn shares
 * another project's, and nothing is one slot for the whole daemon. The daemon's own folder keeps the daemon's own
 * (runtime-graph.ts); this is for every other project.
 */
import { join, resolve } from 'node:path';
import { projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import { HookActivityTracker, HookDispatcher, HookWorkbench, HooksFileAwaitingTrustError, type HookRunnerDeps } from '@goodvibes/engine/platform/platform/hooks';
import { OverflowHandler, type OverflowHandlerConfig } from '@goodvibes/engine/platform/platform/tools';
import { repositoryFileGate, type WorkspaceTrustManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import { traceProjectHookRuns } from '@goodvibes/engine/platform/platform/capabilities';
import type { AgentProjectFacilities, AgentProjectTurn } from '@goodvibes/engine/platform/platform/agents';
import { McpRegistry, createMcpAutonomousElicitationHandler } from '@goodvibes/engine/platform/platform/mcp';
import { SessionChangeTracker } from '@goodvibes/engine/platform/platform/sessions';
import { SandboxSessionRegistry } from '@goodvibes/engine/platform/platform/runtime/sandbox';
import { ProjectPlanningService, ProjectWorkPlan, type KnowledgeStore } from '@goodvibes/engine/platform/platform/knowledge';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { RuntimeEventBus, ShellPathService } from './index.js';
import type { DaemonWorkspaceCheckpoints } from './workspace-checkpointing.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';

type HookEvent = Parameters<HookDispatcher['fire']>[0];
type HookResult = Awaited<ReturnType<HookDispatcher['fire']>>;
type McpPermissionHost = Parameters<McpRegistry['setPermissionHost']>[0];
type WorkPlanStore = NonNullable<AgentProjectFacilities['workPlan']>;

export interface ProjectTurnFacilitiesOptions {
  readonly homeDirectory: string;
  readonly shellPaths: ShellPathService;
  /** The hooks file a project keeps, relative to its folder (`tools.hooksFile`), read when the project is first used. */
  readonly hooksFile: () => string;
  /** The owner's trust of a folder (one manager per folder, shared with the rest of the daemon). */
  readonly trustFor: (folder: string) => WorkspaceTrustManager;
  readonly toolLLM?: HookRunnerDeps['toolLLM'];
  readonly featureFlags?: OverflowHandlerConfig['featureFlags'];
  /** Tool servers: the daemon's settings (the shared `sandbox.*` containment), its sandboxes, bus and permission owner. */
  readonly tools?: {
    readonly configManager: ConfigManager;
    readonly runtimeBus: RuntimeEventBus;
    readonly permissionHost: McpPermissionHost;
  } | undefined;
  /** The checklist: the daemon's knowledge store, the one shared plan file, and a project's identity. */
  readonly workPlans?: {
    readonly knowledgeStore: KnowledgeStore;
    readonly planFile: string;
    readonly projectIdOf: (folder: string) => Promise<string>;
  } | undefined;
  /** The daemon's checkpoint stores, one per workspace (workspace-checkpointing.ts). */
  readonly checkpoints?: Pick<DaemonWorkspaceCheckpoints, 'acquire' | 'bindSession'> | undefined;
}

export interface ProjectTurnFacilities {
  readonly forFolder: (folder: string) => AgentProjectFacilities;
  close(): Promise<void>;
}

/** One project's facilities for every folder in it: a run in a subfolder reads the project root's hooks and tool-server files. */
function keyOf(folder: string): string {
  return projectIdentityOf(folder);
}

/** A plan read from the shared file once the project's identity is known; every call waits for it. */
function lazyWorkPlan(make: () => Promise<ProjectWorkPlan>): WorkPlanStore {
  let plan: Promise<ProjectWorkPlan> | undefined;
  const get = (): Promise<ProjectWorkPlan> => plan ??= make().catch((error: unknown) => { plan = undefined; throw error; });
  return {
    snapshot: async (filter) => (await get()).snapshot(filter),
    add: async (title, fields) => (await get()).add(title, fields),
    update: async (id, patch) => (await get()).update(id, patch),
    setStatus: async (id, status, reason) => (await get()).setStatus(id, status, reason),
    remove: async (id) => (await get()).remove(id),
    clearCompleted: async () => (await get()).clearCompleted(),
  };
}

export function createProjectTurnFacilities(options: ProjectTurnFacilitiesOptions): ProjectTurnFacilities {
  const projects = new Map<string, AgentProjectFacilities & { readonly release: () => Promise<void> }>();
  const build = (key: string): AgentProjectFacilities & { readonly release: () => Promise<void> } => {
    const tracker = new HookActivityTracker();
    const dispatcher = new HookDispatcher({ ...(options.toolLLM ? { toolLLM: options.toolLLM } : {}), projectRoot: key }, tracker);
    const workbench = new HookWorkbench(dispatcher, () => resolve(key, options.hooksFile()));
    const trust = options.trustFor(key);
    // The project's file waits on the owner's trust of this folder, as a program's own does.
    const unbindHooks = workbench.bindTrustGate(repositoryFileGate(trust, options.homeDirectory));
    traceProjectHookRuns(options.shellPaths, key, tracker);
    const loaded = workbench.loadAndApplyManagedHooks().catch((error: unknown) => {
      if (error instanceof HooksFileAwaitingTrustError) return;
      logger.warn('[daemon] a project\'s hooks file was not loaded; the daemon\'s turns there run without its hooks', { project: key, error: summarizeError(error) });
    });
    // Every tool call fires its hooks here first: the call waits for the project's hooks file and its checkpoint
    // baseline (`ready`, below), so a run's first edit in a project lands after the baseline, whatever kind of turn.
    let ready: Promise<void> = loaded;
    const toolCallHooks = { async fire(event: HookEvent): Promise<HookResult> { await ready; return dispatcher.fire(event); } };

    // The project's tool servers: its MCP files (held until the owner trusts the folder) and the owner's own, started
    // in the project, contained as the shared sandbox setting says, every call decided for this project.
    let mcpRegistry: McpRegistry | undefined;
    let unbindMcp: (() => void) | undefined;
    if (options.tools) {
      // Its own sandbox sessions, rooted in the project: a contained server's boundary is the project's folder.
      const sandboxSessions = new SandboxSessionRegistry(key);
      const registry = new McpRegistry({ hookDispatcher: toolCallHooks, sandboxSessions });
      registry.setRuntimeBus(options.tools.runtimeBus);
      registry.setSandboxRuntime(options.tools.configManager, sandboxSessions);
      const host: McpPermissionHost = { ...options.tools.permissionHost, workspaceTrust: trust, workspaceRoot: key };
      registry.setPermissionHost(host);
      // Nobody is sitting at a daemon turn: a server's question its call's own facts cannot answer is declined and
      // handed back to the model in the tool result, as for every turn of the daemon's.
      registry.setElicitationHandler(createMcpAutonomousElicitationHandler(host));
      unbindMcp = registry.bindRepositoryTrust(repositoryFileGate(trust, options.homeDirectory));
      const roots = { workingDirectory: key, homeDirectory: options.homeDirectory };
      registry.setWorkspaceRoots(roots);
      void registry.connectAll(roots).catch((error: unknown) => {
        logger.warn('[daemon] a project\'s tool servers were not started; its turns have none until the files are fixed', { project: key, error: summarizeError(error) });
      });
      mcpRegistry = registry;
    }

    const workPlans = options.workPlans;
    const planServices: ProjectPlanningService[] = [];
    const workPlan = workPlans ? lazyWorkPlan(async () => {
      const projectId = await workPlans.projectIdOf(key);
      const service = new ProjectPlanningService(workPlans.knowledgeStore, { defaultProjectId: projectId, workPlanRowsPath: workPlans.planFile });
      planServices.push(service);
      return new ProjectWorkPlan({ service, projectId, projectRoot: key, surface: GOODVIBES_DAEMON_SURFACE_ROOT,
        exportDirectory: join(options.homeDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'work-plans') });
    }) : undefined;

    const checkpoints = options.checkpoints;
    // The project's store is opened with its environment, before its first turn, so its baseline is the project as
    // the first turn found it and that turn's checkpoint holds what it changed.
    let baseline: Promise<void> = Promise.resolve();
    try {
      const opened = checkpoints?.acquire(key);
      // The store's init takes the project's baseline; a turn awaits it (`ready`) before its first tool call, so the
      // first edit in a project lands after the baseline and its turn's checkpoint holds it.
      if (opened) baseline = opened.manager.init().catch((error: unknown) => {
        logger.warn('[daemon] a project\'s checkpoint baseline was not taken', { project: key, error: summarizeError(error) });
      });
    }
    catch (error) { logger.warn('[daemon] a project\'s checkpoint store was not opened', { project: key, error: summarizeError(error) }); }
    ready = Promise.all([loaded, baseline]).then(() => undefined);
    // A conversation's turn (a session and a turn id) ends with its TURN_COMPLETED on the daemon's bus, which the
    // project's store snapshots once the session is bound to the project here, as a terminal or hosted turn's is. A
    // run of the daemon's own agents (its events name no session) is snapshotted here, explicitly.
    const afterTurn = checkpoints ? (turn: AgentProjectTurn): void => {
      const checkpointing = checkpoints.acquire(key);
      if (!checkpointing) return;
      if (turn.sessionId) checkpoints.bindSession(turn.sessionId, key);
      if (turn.turnId || !checkpointing.currentlyAllowed()) return;
      void checkpointing.manager.create({
        kind: 'agent-run', ...(turn.agentId ? { agentId: turn.agentId } : {}), ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        retentionClass: 'standard', label: 'agent run',
      }).catch((error: unknown) => {
        logger.warn('[daemon] the checkpoint after a turn in a project was not taken', { project: key, error: summarizeError(error) });
      });
    } : undefined;

    return {
      toolCallHooks,
      hookDispatcher: dispatcher,
      ready: () => ready,
      overflowHandler: new OverflowHandler({ baseDir: key, ...(options.featureFlags ? { featureFlags: options.featureFlags } : {}) }),
      ...(mcpRegistry ? { mcpRegistry } : {}),
      ...(workPlan ? { workPlan } : {}),
      changeTracker: new SessionChangeTracker(),
      ...(afterTurn ? { afterTurn } : {}),
      ...(checkpoints ? { bindSession: (sessionId: string) => { checkpoints.acquire(key); checkpoints.bindSession(sessionId, key); } } : {}),
      release: async () => {
        try { unbindHooks(); } catch { /* the trust watch ends with the daemon */ }
        try { unbindMcp?.(); } catch { /* the same */ }
        for (const service of planServices.splice(0)) service.dispose();
        await mcpRegistry?.disconnectAll().catch((error: unknown) => {
          logger.warn('[daemon] a project\'s tool servers did not stop cleanly', { project: key, error: summarizeError(error) });
        });
      },
    };
  };
  return {
    forFolder(folder) {
      const key = keyOf(folder);
      const known = projects.get(key);
      if (known) return known;
      const facilities = build(key);
      projects.set(key, facilities);
      return facilities;
    },
    async close() {
      const open = [...projects.values()];
      projects.clear();
      await Promise.all(open.map((project) => project.release()));
    },
  };
}
