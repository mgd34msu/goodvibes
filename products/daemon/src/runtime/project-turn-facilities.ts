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
import { isAbsolute, join, relative } from 'node:path';
import { checkCallerProject, projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import { HookActivityTracker, HookDispatcher, type HookRunnerDeps } from '@goodvibes/engine/platform/platform/hooks';
import type { OverflowHandlerConfig } from '@goodvibes/engine/platform/platform/tools';
import {
  CODE_INDEX_ENABLED_CONFIG_KEY, createCodeIndexServices, createProjectEnvironment, createProjectToolServers, repositoryFileGate,
  type CodeIndexServices, type CodeIndexServicesDeps, type WorkspaceTrustManager,
} from '@goodvibes/engine/platform/platform/runtime/operations';
import { traceProjectHookRuns } from '@goodvibes/engine/platform/platform/capabilities';
import type { AgentProjectFacilities, AgentProjectTurn } from '@goodvibes/engine/platform/platform/agents';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import { ProjectPlanningService, ProjectWorkPlan, type KnowledgeStore } from '@goodvibes/engine/platform/platform/knowledge';
import { projectSettingsInForce, projectFeatureFlags, type ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { getFeatureSettingsBinding } from '@goodvibes/engine/platform/platform/runtime/feature-flags';
import { logger, outsideEveryCall, summarizeError } from '@goodvibes/engine/platform/platform/utils';
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
  /** An `agent` hook's spawn, as a program's dispatcher has it (the daemon's agent manager). */
  readonly agentManager?: HookRunnerDeps['agentManager'];
  /** The daemon's hook-action runner (a hook's `command` action), as a program's dispatcher has its own. */
  readonly hookActions?: Parameters<HookDispatcher['setHookActions']>[0] | undefined;
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
    /** The daemon's bus: a project's plan announces its tasks and its changes there, as the daemon's own plan does. */
    readonly runtimeBus?: RuntimeEventBus | undefined;
    /** Told each project's plan id and folder once known, so the daemon's own planning service names the project too. */
    readonly noteProject?: ((projectId: string, folder: string) => void) | undefined;
  } | undefined;
  /**
   * The project's secret stores as a turn there reads them: the daemon's and the owner's, then that project's own (the
   * store "This project" writes, as capabilities/daemon-services.ts `secretsViewFor` reads it). Made once per project.
   */
  readonly secretsFor?: ((folder: string) => NonNullable<AgentProjectFacilities['secretsManager']>) | undefined;
  /** The services a turn in the project reaches, their credentials read from the project's secret store first. Made once per project. */
  readonly serviceRegistryFor?: ((folder: string) => NonNullable<AgentProjectFacilities['serviceRegistry']>) | undefined;
  /**
   * The project's code index: the one the terminal app keeps in that folder (`.goodvibes/<surfaceRoot>/code-index.sqlite`),
   * opened on a turn's first ask while the code index setting is on, with the daemon's embedding registry.
   */
  readonly codeIndex?: {
    readonly surfaceRoot: string;
    readonly configManager: CodeIndexServicesDeps['configManager'];
    readonly memoryEmbeddingRegistry: CodeIndexServicesDeps['memoryEmbeddingRegistry'];
    /** Whether the index is kept: the daemon's one setting `storage.codeIndexEnabled`, read live. */
    readonly enabled: () => boolean;
  } | undefined;
  /** The daemon's checkpoint stores, one per workspace (workspace-checkpointing.ts). */
  readonly checkpoints?: Pick<DaemonWorkspaceCheckpoints, 'acquire' | 'bindSession' | 'release'> | undefined;
  /** The daemon's home (`<home>/.goodvibes/daemon` unless moved): no folder in or above it is a project. */
  readonly daemonHome: string;
}

export interface ProjectTurnFacilities {
  /**
   * The project's facilities for a folder in it, built on first use. Refused (thrown) for a folder that is no project:
   * the root, the home folder, or in or above the GoodVibes or daemon home (workspace/caller-project.ts): a caller's
   * project was checked at its door, and nothing reaches here that would start tool servers or take a baseline there.
   */
  readonly forFolder: (folder: string) => AgentProjectFacilities;
  /** `forFolder`, held for good (a project's Work graph keeps its project's facilities while the daemon runs). */
  hold(folder: string): AgentProjectFacilities;
  /**
   * The orchestrator let the folder's last registry go (agents/orchestrator.ts `releaseProjectFacilities`): once no
   * folder of its project is held, the project's tool servers stop, its hooks and code index are let go and its
   * checkpoint store closes; the next run there builds them again. A project's Work graph holds its own for good.
   */
  release(folder: string): void;
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
  // The release of a project's facilities in flight, per project (see `release`).
  const releasing = new Map<string, Promise<void>>();
  const build = (key: string): AgentProjectFacilities & { readonly release: () => Promise<void> } => {
    const tracker = new HookActivityTracker();
    // Built as a program builds its own (runtime/client-services.ts): agent hooks spawn, command actions run, under
    // the same command guard. The action runner is the daemon's one; its detach is the daemon's at shutdown.
    const dispatcher = new HookDispatcher({ ...(options.toolLLM ? { toolLLM: options.toolLLM } : {}),
      ...(options.agentManager ? { agentManager: options.agentManager } : {}), projectRoot: key }, tracker);
    if (options.hookActions) void dispatcher.setHookActions(options.hookActions, options.featureFlags ?? undefined);
    const trust = options.trustFor(key);
    traceProjectHookRuns(options.shellPaths, key, tracker);
    // Every tool call fires its hooks here first: the call waits for the project's hooks file and its checkpoint
    // baseline (`ready`, below), so a run's first edit in a project lands after the baseline, whatever kind of turn.
    let ready: Promise<void> = Promise.resolve();
    const toolCallHooks = { async fire(event: HookEvent): Promise<HookResult> { await ready; return dispatcher.fire(event); } };
    // The project's environment from the ONE builder every host uses (runtime/project-environment.ts): its hooks file
    // (waiting on the owner's trust of this folder), its tool servers (its MCP files and the owner's own, started in the
    // project in sandbox sessions rooted there), its long-output folder and changed-files record.
    const environment = createProjectEnvironment({
      folder: key, homeDirectory: options.homeDirectory, trust, hookDispatcher: dispatcher, toolCallHooks,
      hooksFile: options.hooksFile,
      ...(options.tools ? { toolServers: { configManager: options.tools.configManager, runtimeBus: options.tools.runtimeBus } } : {}),
      ...(options.featureFlags ? { overflow: { featureFlags: options.featureFlags } } : {}),
      // Files changed outside the daemon's turns here fire the project's external-change hooks, as in a program there.
      watchExternalChanges: true,
    });
    const loaded = environment.hooks.load();
    ready = loaded;
    const toolServers = environment.toolServers;
    if (toolServers && options.tools) {
      // A server's call is decided for this project (its rules, trust and answers), whichever turn made it: a hosted
      // session's turn names no project of its own to the daemon's permission owner. Nobody is sitting at a daemon
      // turn: a server's question its call's own facts cannot answer is declined and handed back to the model.
      toolServers.bindPermissions({ ...options.tools.permissionHost, workspaceTrust: trust, workspaceRoot: key }, { project: key });
      void toolServers.connect();
    }
    const mcpRegistry = toolServers?.mcpRegistry;

    const workPlans = options.workPlans;
    const planServices: ProjectPlanningService[] = [];
    // Made on a turn's first use: in the process's own context, as the rest of the project's facilities.
    const workPlan = workPlans ? lazyWorkPlan(() => outsideEveryCall(async () => {
      const projectId = await workPlans.projectIdOf(key);
      // With the daemon's bus and its folder: every task added, changed or removed in this project's plan is announced,
      // saying it is about this project (events/about.ts), so the callers given the project see it and nobody else.
      const service = new ProjectPlanningService(workPlans.knowledgeStore, {
        defaultProjectId: projectId, workPlanRowsPath: workPlans.planFile, projectRoot: key,
        ...(workPlans.runtimeBus ? { runtimeBus: workPlans.runtimeBus } : {}),
      });
      workPlans.noteProject?.(projectId, key);
      planServices.push(service);
      return new ProjectWorkPlan({ service, projectId, projectRoot: key, surface: GOODVIBES_DAEMON_SURFACE_ROOT,
        exportDirectory: join(options.homeDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'work-plans') });
    })) : undefined;

    // The daemon's settings with this project as the folder a turn engine works in, and the project's own layer over
    // them: the project's one settings file every program reads (`<project>/.goodvibes/settings.json`, the programs'
    // old files carried into it once), admitted as a program's project layer is. The one reader of the settings in force
    // for this project: the daemon's permission manager decides this project's calls with the same view.
    const settingsView = options.tools ? projectSettingsInForce(options.tools.configManager, key) : undefined;

    // The project's code index, opened on first ask while the setting is on (off by default: nothing is opened).
    let codeIndex: CodeIndexServices | undefined;
    const codeIndexOptions = options.codeIndex;
    const codeIndexOf = codeIndexOptions ? () => {
      if (!codeIndex && !codeIndexOptions.enabled()) return undefined;
      // Made on a turn's first ask in the project (it is built then, when the setting is on); the build and the reindex
      // after edits read the same switch, the daemon's one setting.
      const switchedBy = { get: (setting: string): unknown => setting === CODE_INDEX_ENABLED_CONFIG_KEY
        ? codeIndexOptions.enabled() : (codeIndexOptions.configManager.get as (key: string) => unknown)(setting) } as CodeIndexServicesDeps['configManager'];
      // Its store and its reindex timer are the project's, made in the process's own context whichever turn asked first.
      codeIndex ??= outsideEveryCall(() => createCodeIndexServices({ workingDirectory: key, surfaceRoot: codeIndexOptions.surfaceRoot,
        configManager: switchedBy, memoryEmbeddingRegistry: codeIndexOptions.memoryEmbeddingRegistry }));
      return { source: codeIndex.codeIndexStore, reindex: codeIndex.codeIndexReindexScheduler };
    } : undefined;

    const checkpoints = options.checkpoints;
    // The project's store is opened with its environment, before its first turn, so its baseline is the project as
    // the first turn found it and that turn's checkpoint holds what it changed.
    let baseline: Promise<void> = Promise.resolve();
    let store: { settled?(): Promise<void> } | undefined;
    try {
      const opened = checkpoints?.acquire(key);
      store = opened?.manager;
      // The store's init takes the project's baseline; a turn awaits it (`ready`) before its first tool call, so the
      // first edit in a project lands after the baseline and its turn's checkpoint holds it.
      if (opened) baseline = opened.manager.init().catch((error: unknown) => {
        logger.warn('[daemon] a project\'s checkpoint baseline was not taken', { project: key, error: summarizeError(error) });
      });
    }
    catch (error) { logger.warn('[daemon] a project\'s checkpoint store was not opened', { project: key, error: summarizeError(error) }); }
    // A release of this project's earlier facilities still in flight is waited for first (`releasing`): the turn starts
    // on this fresh set once the old one is let go, and the old release closes nothing this set holds.
    ready = Promise.all([loaded, baseline, releasing.get(key)]).then(() => undefined);
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
      ...(options.secretsFor ? { secretsManager: options.secretsFor(key) } : {}),
      ...(options.serviceRegistryFor ? { serviceRegistry: options.serviceRegistryFor(key) } : {}),
      ...(codeIndexOf ? { codeIndex: codeIndexOf } : {}),
      // The daemon's settings with this project as the folder a turn engine works in (made once, reused).
      ...(settingsView ? { configManager: settingsView } : {}),
      // A feature whose state is a setting (the exec boundary's `sandbox.enabled`) follows the project's layer too.
      ...(settingsView && options.featureFlags ? { featureFlags: projectFeatureFlags(options.featureFlags, settingsView, (flag) => getFeatureSettingsBinding(flag)?.key) } : {}),
      // Also every checkpoint asked of the project's store so far: a turn that ended a moment ago (finished, failed,
      // cancelled) has its own checkpoint taken before the next turn's first call changes anything.
      ready: () => store?.settled ? Promise.all([ready, store.settled()]).then(() => undefined) : ready,
      hookWorkbench: environment.hooks.workbench,
      hookActivityTracker: tracker,
      overflowHandler: environment.overflowHandler,
      ...(mcpRegistry ? { mcpRegistry } : {}),
      ...(workPlan ? { workPlan } : {}),
      changeTracker: environment.changeTracker,
      ...(afterTurn ? { afterTurn } : {}),
      ...(checkpoints ? { bindSession: (sessionId: string) => { checkpoints.acquire(key); checkpoints.bindSession(sessionId, key); } } : {}),
      // A step of planned work runs in a captured copy of the project: its tool servers start inside that copy (its
      // files there, its sandbox sessions rooted there), under this project's trust, its calls decided for this project.
      ...(options.tools ? { capturedToolServers: (copyRoot: string) => {
        const tools = options.tools!;
        // A server file in the copy waits on the owner's trust as the same file in the project does.
        const projectGate = repositoryFileGate(trust, options.homeDirectory);
        const gate = { ...projectGate, holds: (path: string) => {
          const inCopy = relative(copyRoot, path);
          return projectGate.holds(inCopy.startsWith('..') || isAbsolute(inCopy) ? path : join(key, inCopy));
        } };
        const servers = createProjectToolServers({ folder: copyRoot, homeDirectory: options.homeDirectory, configManager: tools.configManager,
          runtimeBus: tools.runtimeBus, hookDispatcher: toolCallHooks, gate });
        servers.bindPermissions({ ...tools.permissionHost, workspaceTrust: trust, workspaceRoot: key }, { project: key });
        // Started by the step's first `mcp` call (tools/mcp createMcpTool `connect`), not here at the step's start.
        return { mcpRegistry: servers.mcpRegistry, connect: () => servers.connect(), release: () => servers.release() };
      } } : {}),
      release: async () => {
        for (const service of planServices.splice(0)) service.dispose();
        if (codeIndex) {
          try { codeIndex.codeIndexReindexScheduler.dispose(); codeIndex.codeIndexStore.close(); } catch { /* closed with the daemon */ }
        }
        await environment.release();
      },
    };
  };
  // The folders of each project that hold its facilities now (told by `release` when one is let go), and the projects
  // held for good (a project's Work graph, `hold`).
  const held = new Map<string, Set<string>>();
  const pinned = new Set<string>();
  const facts = { homeDirectory: options.homeDirectory, goodVibesHome: join(options.homeDirectory, '.goodvibes'), daemonHome: options.daemonHome, assignedProjects: () => [] };
  const facilities: ProjectTurnFacilities = {
    hold(folder) {
      const project = facilities.forFolder(folder);
      pinned.add(keyOf(folder));
      return project;
    },
    forFolder(folder) {
      // Only a folder that can be a project: the never-a-project rules of the one check (the owner's own program's, the
      // widest: a device's or member's project was narrowed further at its door).
      const checked = checkCallerProject(folder, { ownersProgram: true }, facts);
      if (!checked.ok) throw new Error(`Not started: ${checked.reason}, so no tool server, hook or checkpoint is made for it.`);
      const key = keyOf(folder);
      const folders = held.get(key) ?? new Set<string>();
      folders.add(folder);
      held.set(key, folders);
      const known = projects.get(key);
      if (known) return known;
      // Made by whichever turn or request first works there: built in the process's own context, so its tool servers,
      // its watchers and everything they start later are no caller's (engine utils/outside-every-call.ts).
      const made = outsideEveryCall(() => build(key));
      projects.set(key, made);
      return made;
    },
    release(folder) {
      const key = keyOf(folder);
      const folders = held.get(key);
      folders?.delete(folder);
      if ((folders && folders.size > 0) || pinned.has(key)) return;
      held.delete(key);
      const project = projects.get(key);
      if (!project) return;
      projects.delete(key);
      // One ordered thing per project: releases run one after another, and a new set made for the project meanwhile
      // (a turn arriving during the release) keeps its checkpoint store: it is closed only while nothing holds the project.
      // The release queue is the daemon's own, whichever run let the project go.
      const done: Promise<void> = outsideEveryCall(() => (releasing.get(key) ?? Promise.resolve())
        .then(() => project.release())
        .then(async () => { if (!projects.has(key)) await options.checkpoints?.release(key); })
        .catch((error: unknown) => {
          logger.warn('[daemon] a project\'s facilities were not let go cleanly', { project: key, error: summarizeError(error) });
        })
        .finally(() => { if (releasing.get(key) === done) releasing.delete(key); }));
      releasing.set(key, done);
    },
    async close() {
      const open = [...projects.values()];
      projects.clear();
      held.clear();
      pinned.clear();
      await Promise.all([...open.map((project) => project.release()), ...releasing.values()]);
    },
  };
  return facilities;
}
