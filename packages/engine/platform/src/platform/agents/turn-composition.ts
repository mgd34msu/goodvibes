/**
 * turn-composition.ts, the ONE way a turn's tools are put together, in whichever process runs the turn.
 *
 * A turn has the same tools wherever it runs (a terminal app's own conversation, the Agent's, a web chat, a schedule,
 * a hosted session, a unit of planned work): the platform tools, built by `registerAllTools`, over three inputs that
 * are named here so nothing else decides them:
 *
 *  - the HOST: what the process running the turn gives every turn (its stores, its agent manager, its permission
 *    callbacks, the session's own callbacks such as `resolveSessionId`);
 *  - the PROJECT: the environment of the project the turn works in, built once per project by its host (the daemon's
 *    `project-turn-facilities.ts`, a terminal program's own client services): its tool servers, its checklist, its
 *    changed-files record, where its long output is kept, its hook dispatcher, its settings view, its secrets and the
 *    gates that follow its settings. When a project is given, these come from it and never from the host;
 *  - the PROGRAM: where the programs differ on purpose, stated rather than composed twice: the program's own storage
 *    root (`surfaceRoot`), its read and settings admission, its settings routing. Its own extra tools (the Agent's
 *    turn tools, the capability pair) are registered after this, by the same program, on the same registry.
 *
 * Used by the daemon's turns (agents/orchestrator.ts getFullRegistry), its hosted sessions
 * (hosted-sessions/session-runtime.ts), the terminal app (products/tui runtime/turn-tool-composition.ts) and the Agent
 * (products/agent runtime/agent-tool-registry.ts).
 */
import { registerAllTools } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentProjectFacilities } from './orchestrator.js';

/** Everything `registerAllTools` takes. */
export type TurnToolDeps = NonNullable<Parameters<typeof registerAllTools>[1]>;

/** What a program states about itself where the programs differ on purpose. */
export interface TurnProgram {
  /** The program's own storage root (`.goodvibes/<surfaceRoot>/` for its per-surface tool state). */
  readonly surfaceRoot: string;
  /** The program's own read and settings admission (the Agent's read modes); absent, the platform's. */
  readonly readAdmissionPolicy?: TurnToolDeps['readAdmissionPolicy'];
  readonly settingsAdmissionPolicy?: TurnToolDeps['settingsAdmissionPolicy'];
  /** Where a setting the program does not own is read and written (the daemon's for a daemon-owned key). */
  readonly configRouting?: TurnToolDeps['configRouting'];
  /** The program brings its own plan tool (the Agent's `agent_work_plan`): the project's checklist is not offered as `work_plan`. */
  readonly ownPlanTool?: boolean | undefined;
}

/** The inputs of one turn's tools. See the module header. */
export interface TurnComposition {
  readonly host: Omit<TurnToolDeps, 'surfaceRoot'>;
  readonly project?: AgentProjectFacilities | undefined;
  readonly program: TurnProgram;
}

/**
 * The project's part of a turn's tools: what a turn in that project has instead of the host's own. A host that manages
 * hooks (a conversation: `state mode=hooks`) is given the project's dispatcher; one that only fires them keeps firing
 * through `toolCallHooks`, which its own run context binds.
 */
export function projectTurnDeps(project: AgentProjectFacilities, host: Pick<TurnToolDeps, 'hookDispatcher'>, program?: Pick<TurnProgram, 'ownPlanTool'>): Partial<TurnToolDeps> {
  return {
    mcpRegistry: project.mcpRegistry,
    ...(project.mcpConnect ? { mcpConnect: project.mcpConnect } : {}),
    workPlan: program?.ownPlanTool === true ? undefined : project.workPlan,
    overflowHandler: project.overflowHandler,
    ...(project.changeTracker ? { changeTracker: project.changeTracker } : {}),
    ...(project.configManager ? { configManager: project.configManager } : {}),
    ...(project.secretsManager ? { secretsManager: project.secretsManager } : {}),
    ...(project.serviceRegistry ? { serviceRegistry: project.serviceRegistry } : {}),
    ...(project.featureFlags ? { featureFlags: project.featureFlags } : {}),
    ...(host.hookDispatcher && project.hookDispatcher ? { hookDispatcher: project.hookDispatcher } : {}),
  };
}

/**
 * A terminal program's project environment, from its own composition (runtime/client-services.ts builds it once for
 * the folder the program runs in): the same parts the daemon's `project-turn-facilities.ts` builds per project.
 */
export function programProjectFacilities(services: {
  readonly mcpRegistry: NonNullable<AgentProjectFacilities['mcpRegistry']>;
  readonly workPlan?: AgentProjectFacilities['workPlan'];
  readonly sessionChangeTracker?: AgentProjectFacilities['changeTracker'];
  readonly overflowHandler: NonNullable<AgentProjectFacilities['overflowHandler']>;
  readonly hookDispatcher: NonNullable<AgentProjectFacilities['hookDispatcher']>;
  readonly secretsManager?: AgentProjectFacilities['secretsManager'] | null;
  readonly featureFlags?: AgentProjectFacilities['featureFlags'] | null;
}, configManager: NonNullable<AgentProjectFacilities['configManager']>): AgentProjectFacilities {
  return {
    mcpRegistry: services.mcpRegistry,
    ...(services.workPlan ? { workPlan: services.workPlan } : {}),
    ...(services.sessionChangeTracker ? { changeTracker: services.sessionChangeTracker } : {}),
    overflowHandler: services.overflowHandler,
    hookDispatcher: services.hookDispatcher,
    toolCallHooks: services.hookDispatcher,
    configManager,
    ...(services.secretsManager ? { secretsManager: services.secretsManager } : {}),
    ...(services.featureFlags ? { featureFlags: services.featureFlags } : {}),
  };
}

/** Registers one turn's tools on `registry` from its three inputs. Returns what `registerAllTools` returns. */
export function composeTurnTools(registry: ToolRegistry, composition: TurnComposition): ReturnType<typeof registerAllTools> {
  const { host, project, program } = composition;
  return registerAllTools(registry, {
    ...host,
    ...(project ? projectTurnDeps(project, host, program) : {}),
    surfaceRoot: program.surfaceRoot,
    ...(program.readAdmissionPolicy !== undefined ? { readAdmissionPolicy: program.readAdmissionPolicy } : {}),
    ...(program.settingsAdmissionPolicy !== undefined ? { settingsAdmissionPolicy: program.settingsAdmissionPolicy } : {}),
    ...(program.configRouting !== undefined ? { configRouting: program.configRouting } : {}),
  });
}
