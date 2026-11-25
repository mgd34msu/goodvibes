/**
 * `/agents`, described once (command-actions/) for both terminal apps. Typed
 * bare by a person it opens the Work place on Your agents; every other action
 * is a capability (platform builtin/agents.ts) with its control in that place:
 * team modes, recipes and archetypes run in the terminal app's own session
 * (what an agent hands over as work runs on the daemon, in Work), the coding
 * agents the daemon hosts run in the daemon,
 * and coding work handed to the terminal app is a shared session the daemon
 * makes and keeps the record of (builtin/handed-off.ts).
 */
import {
  AGENTS_HAND_OFF, AGENTS_HANDED_OFF, AGENTS_HANDED_OFF_LIST,
  AGENTS_ARCHETYPE, AGENTS_ARCHETYPES, AGENTS_ARCHETYPES_LIST, AGENTS_GROUPS_LIST, AGENTS_HOST, AGENTS_HOSTABLE,
  AGENTS_HOSTABLE_LIST, AGENTS_RECIPE, AGENTS_RUNNING_LIST, AGENTS_START, AGENTS_START_ARCHETYPE, AGENTS_STOP, AGENTS_STOP_BRANCH, AGENTS_STOP_GROUP, AGENTS_TEAM,
  type AgentArchetypeRow, type AgentsCapabilityServices, type CapabilityDefinition, type RunningAgentRow,
} from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, runDaemonCapability, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext, CommandDescription } from './command-actions/types.js';
import { doAction } from './described-command-kit.js';

export { TEAM_MODES, TEAM_RECIPES } from '@goodvibes/engine/platform/platform/capabilities';

/** A reason this app cannot do a group of actions, shown when one of them is asked for. */
export interface Unavailable { readonly unavailable: string }
type Can<T> = T | Unavailable;

export type { RunningAgentRow };
export type ArchetypeRow = AgentArchetypeRow;

/** What one app does for `/agents`. */
export interface AgentsHost<Ctx> {
  /** The agents this app started, and stopping them. */
  readonly contracts: Can<{
    running(ctx: Ctx): readonly RunningAgentRow[];
    /** Every agent started in this session, the ended ones too. */
    started(ctx: Ctx): readonly RunningAgentRow[];
    stop(ctx: Ctx, agentId: string, note: string): string;
    stopGroup(ctx: Ctx, graphId: string): string;
    stopBranch(ctx: Ctx, agentId: string): string;
  }>;
  /** Team modes, recipes and archetypes, and starting agents from them. */
  readonly team: Can<{
    review(ctx: Ctx): string;
    archetypes(ctx: Ctx): readonly ArchetypeRow[];
    archetypeReport(ctx: Ctx, name: string): string;
    startMode(ctx: Ctx, mode: string, title: string): string;
    runRecipe(ctx: Ctx, recipe: string, title: string): string;
    startArchetype(ctx: Ctx, name: string, title: string): string;
  }>;
}

let installed: AgentsHost<CommandActionContext> | undefined;
let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;
function readable<T extends object, R>(part: Can<T> | undefined, read: (value: T) => R, otherwise: R): R {
  return part && !('unavailable' in part) ? read(part) : otherwise;
}

/** The capabilities' services from this app's host, bound to the conversation (absent where the app has none). */
function agentsServices(ctx: CommandActionContext): AgentsCapabilityServices {
  const team = installed?.team && !('unavailable' in installed.team) ? installed.team : undefined;
  const contracts = installed?.contracts && !('unavailable' in installed.contracts) ? installed.contracts : undefined;
  return {
    ...(team ? { agentTeam: {
      review: () => team.review(ctx), archetypes: () => team.archetypes(ctx), archetypeReport: (name: string) => team.archetypeReport(ctx, name),
      startMode: (mode: string, title: string) => team.startMode(ctx, mode, title), runRecipe: (recipe: string, title: string) => team.runRecipe(ctx, recipe, title),
      startArchetype: (name: string, title: string) => team.startArchetype(ctx, name, title),
    } } : {}),
    ...(contracts ? { agentContracts: {
      running: () => contracts.running(ctx), started: () => contracts.started(ctx),
      stop: (id: string, note: string) => contracts.stop(ctx, id, note),
      stopGroup: (id: string) => contracts.stopGroup(ctx, id), stopBranch: (id: string) => contracts.stopBranch(ctx, id),
    } } : {}),
  };
}

defineList<CommandActionContext>({
  name: AGENTS_HOSTABLE_LIST,
  async read(ctx) {
    if (!binding) return [];
    const agents = (await runDaemonCapability('agents.hostable', {}, ctx, binding)).data?.['agents'];
    return (Array.isArray(agents) ? agents as Record<string, unknown>[] : []).map((agent): ListRow => ({ value: String(agent['id']), label: String(agent['title'] ?? agent['id']), detail: String(agent['binaryPath'] ?? '') }));
  },
  operator: { method: 'capabilities.run', input: { id: 'agents.hostable' }, rows: { from: 'data.agents', value: 'id', label: 'title', detail: 'binaryPath' } },
});
defineList<CommandActionContext>({
  name: AGENTS_HANDED_OFF_LIST,
  async read(ctx) {
    if (!binding) return [];
    const handed = (await runDaemonCapability('agents.handed-off', {}, ctx, binding)).data?.['handedOff'];
    return (Array.isArray(handed) ? handed as Record<string, unknown>[] : []).map((entry): ListRow => ({
      value: String(entry['sessionId']), label: String(entry['task'] ?? '').replace(/\s+/g, ' ').slice(0, 72), detail: String(entry['createdAt'] ?? '').slice(0, 16).replace('T', ' '), state: String(entry['state'] ?? ''),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'agents.handed-off' }, rows: { from: 'data.handedOff', value: 'sessionId', label: 'task', detail: 'createdAt', state: 'state' } },
});
defineList<CommandActionContext>({
  name: AGENTS_RUNNING_LIST,
  async read(ctx) {
    return readable(installed?.contracts, (contracts) => contracts.running(ctx).map((row): ListRow => ({ value: row.id, label: row.task.slice(0, 72), state: row.status })), [] as ListRow[]);
  },
  operator: { terminalOnly: 'Agents run in the terminal app that started them.' },
});
defineList<CommandActionContext>({
  name: AGENTS_GROUPS_LIST,
  async read(ctx) {
    return readable(installed?.contracts, (contracts) => {
      const counts = new Map<string, number>();
      for (const row of contracts.running(ctx)) if (row.graphId) counts.set(row.graphId, (counts.get(row.graphId) ?? 0) + 1);
      return [...counts].map(([graphId, count]): ListRow => ({ value: graphId, label: graphId, state: `${count} running` }));
    }, [] as ListRow[]);
  },
  operator: { terminalOnly: 'Agents run in the terminal app that started them.' },
});
defineList<CommandActionContext>({
  name: AGENTS_ARCHETYPES_LIST,
  async read(ctx) {
    return readable(installed?.team, (team) => team.archetypes(ctx).map((row): ListRow => ({ value: row.id, label: row.id, detail: row.label, state: row.issues > 0 ? `${row.issues} problem${row.issues === 1 ? '' : 's'}` : row.family })), [] as ListRow[]);
  },
  operator: { terminalOnly: 'Archetypes are read from this project\'s agents folder by the terminal app.' },
});

const TERMINAL_ONLY = 'It runs in the terminal app\'s session.';
type PlaceOpener = { readonly openPlace?: ((id: string, start?: { readonly list?: string | undefined }) => void) | undefined };

function agentsCommand(daemon: DaemonCapabilityBinding<CommandActionContext>): CommandDescription<CommandActionContext> {
  const session = (definition: CapabilityDefinition<AgentsCapabilityServices>) =>
    sessionCapabilityAction<CommandActionContext, AgentsCapabilityServices>(definition, agentsServices, { terminalOnly: TERMINAL_ONLY });
  return {
    name: 'agents',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Your agents',
    summary: 'What your agents are doing: open them in the Work place, start agents, host a coding agent, hand work on, and stop work',
    group: 'Agents and work',
    // Typed bare by a person, it opens the Work place on Your agents.
    bareOpens: 'open',
    actions: [
      doAction<CommandActionContext>({
        id: 'open', label: 'Open Your agents', word: 'open', touches: 'reads', inputs: [],
        sentence: 'Opens the Work place on Your agents: what is running, the archetypes and the coding agents you can host.',
        operator: { terminalOnly: 'It is a terminal screen; the web UI shows the same in its Work view.' },
        async run(_values, ctx) {
          const open = (ctx as CommandActionContext & PlaceOpener).openPlace;
          if (!open) throw commandRefusal('This program has no screens to open.');
          open('work', { list: 'agents' });
        },
      }),
      daemonCapabilityAction<CommandActionContext>(AGENTS_HOSTABLE, daemon),
      daemonCapabilityAction<CommandActionContext>(AGENTS_HOST, daemon),
      session(AGENTS_TEAM), session(AGENTS_START), session(AGENTS_RECIPE), session(AGENTS_ARCHETYPES), session(AGENTS_ARCHETYPE), session(AGENTS_START_ARCHETYPE),
      daemonCapabilityAction<CommandActionContext>(AGENTS_HAND_OFF, daemon),
      daemonCapabilityAction<CommandActionContext>(AGENTS_HANDED_OFF, daemon),
      session(AGENTS_STOP), session(AGENTS_STOP_GROUP), session(AGENTS_STOP_BRANCH),
    ],
  };
}

/** Register `/agents` (the one description) with this app's host and its daemon binding (capability-binding.ts). */
export function registerAgentsCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: AgentsHost<Ctx>, daemon: DaemonCapabilityBinding<Ctx>): void {
  installed = host as unknown as AgentsHost<CommandActionContext>;
  binding = daemon as unknown as DaemonCapabilityBinding<CommandActionContext>;
  registry.register(defineCommand(agentsCommand(binding)) as never);
}
