/**
 * `/agents`, described once (command-actions/) for both terminal apps: your
 * agents in one place. Open the live view, host a third-party coding agent,
 * start agents in a team mode or a recipe, read and stop work contracts and
 * agent groups, and (in the Agent) hand coding work to the terminal app and
 * follow it. Each app installs what it can do; an action this app cannot do
 * is refused with the reason, so both apps show the same list.
 */
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';
import { choiceInput, doAction, listInput, readAction, textInput } from './described-command-kit.js';

/** A reason this app cannot do a group of actions, shown when one of them is asked for. */
export interface Unavailable { readonly unavailable: string }
type Can<T> = T | Unavailable;

export interface HostableAgent { readonly id: string; readonly title: string; readonly binaryPath: string }
export interface HandOffInput {
  readonly task: string;
  readonly reviewRequested: boolean;
  readonly reason: string;
  readonly successCriteria: string;
  readonly workspaceHint: string;
  readonly priority: string;
}
export interface HandOffRecord { readonly sessionId: string; readonly task: string; readonly createdAt: string }
export interface ContractRow { readonly id: string; readonly ask: string; readonly status: string }
export interface RunningAgentRow { readonly id: string; readonly task: string; readonly status: string; readonly graphId?: string | undefined }
export interface ArchetypeRow { readonly id: string; readonly label: string; readonly family: string; readonly issues: number }

/** What one app does for `/agents`. */
export interface AgentsHost<Ctx> {
  /** Open the live view of agents; `target` selects a process in it. Throws a refusal when it cannot. */
  readonly openPanel: (ctx: Ctx, target: string) => void;
  /** Third-party coding agents (Claude Code, Codex, opencode) this machine can host. */
  readonly coding: Can<{
    list(ctx: Ctx): Promise<readonly HostableAgent[]>;
    host(ctx: Ctx, agentId: string, directory: string): Promise<string>;
  }>;
  /** Handing coding work to the terminal app through a shared session. */
  readonly handOff: Can<{
    send(ctx: Ctx, input: HandOffInput): Promise<string>;
    recorded(ctx: Ctx): readonly HandOffRecord[];
    status(ctx: Ctx, sessionId: string): Promise<string>;
  }>;
  /** Work contracts and the agents running them. */
  readonly contracts: Can<{
    list(ctx: Ctx): readonly ContractRow[];
    show(ctx: Ctx, contractId: string): string;
    running(ctx: Ctx): readonly RunningAgentRow[];
    stopGroup(ctx: Ctx, graphId: string): string;
    stopBranch(ctx: Ctx, agentId: string): string;
    openView(ctx: Ctx): void;
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

/** The team modes: what each starts. The terminal app keeps how each one runs. */
export const TEAM_MODES: readonly FixedChoice[] = [
  { value: 'local-engineer', label: 'An engineer here', help: 'Gathers, plans, then changes files in this project.' },
  { value: 'local-shell', label: 'A shell task here', help: 'Runs commands directly.' },
  { value: 'remote-engineer', label: 'An engineer on a remote runner', help: 'Started with /remote dispatch; listed here for the recipes that use it.' },
  { value: 'teammate', label: 'A general teammate', help: 'A focused helper in this session.' },
  { value: 'research', label: 'A researcher', help: 'Reads and reports; changes nothing.' },
  { value: 'dream', label: 'A speculative researcher', help: 'Explores an idea freely, then reports.' },
  { value: 'review', label: 'A reviewer', help: 'Reviews work; changes nothing.' },
  { value: 'verifier', label: 'A verifier', help: 'Checks that work meets what was asked.' },
  { value: 'integration', label: 'An integrator', help: 'Brings finished work together.' },
];

/** The recipes: agents that run one after another, each handed the last one's report. */
export const TEAM_RECIPES: readonly (FixedChoice & { readonly steps: readonly string[] })[] = [
  { value: 'research-implement-review', label: 'Research, build, review, verify', help: 'Research first, build second, then review and verify.', steps: ['research', 'local-engineer', 'review', 'verifier'] },
  { value: 'remote-certification', label: 'Build remotely, review and integrate here', help: 'A remote engineer builds; it is reviewed and integrated here.', steps: ['remote-engineer', 'review', 'integration'] },
  { value: 'triage-delegate-integrate', label: 'Triage, hand to a teammate, integrate', help: 'Triage here, give focused work to a teammate, then integrate.', steps: ['teammate', 'review', 'integration'] },
  { value: 'dream-then-certify', label: 'Explore, then build, review and verify', help: 'A speculative pass, grounded by building, review and verification.', steps: ['dream', 'local-engineer', 'review', 'verifier'] },
];

let installed: AgentsHost<CommandActionContext> | undefined;
function hostOf(): AgentsHost<CommandActionContext> {
  if (!installed) throw commandRefusal('Agents are not available in this session.');
  return installed;
}
function able<T extends object>(part: Can<T>): T {
  if ('unavailable' in part) throw commandRefusal(part.unavailable);
  return part;
}
function readable<T extends object, R>(part: Can<T> | undefined, read: (value: T) => R, otherwise: R): R {
  return part && !('unavailable' in part) ? read(part) : otherwise;
}

const HOSTABLE = defineList<CommandActionContext>({
  name: 'agents.hostable',
  async read(ctx) {
    const coding = installed?.coding;
    if (!coding || 'unavailable' in coding) return [];
    return (await coding.list(ctx)).map((agent): ListRow => ({ value: agent.id, label: agent.title, detail: agent.binaryPath }));
  },
  operator: { method: 'acp.agents.list', input: {}, rows: { from: 'agents', value: 'id', label: 'title', detail: 'binaryPath' } },
});
const HANDED_OFF = defineList<CommandActionContext>({
  name: 'agents.handed-off',
  async read(ctx) {
    return readable(installed?.handOff, (handOff) => handOff.recorded(ctx).map((entry): ListRow => ({ value: entry.sessionId, label: entry.task.slice(0, 72), detail: entry.createdAt.slice(0, 16).replace('T', ' ') })), [] as ListRow[]);
  },
  operator: { terminalOnly: 'Hand-offs are recorded in the Agent\'s own home.' },
});
const CONTRACTS = defineList<CommandActionContext>({
  name: 'agents.contracts',
  async read(ctx) {
    return readable(installed?.contracts, (contracts) => contracts.list(ctx).map((row): ListRow => ({ value: row.id, label: row.ask.slice(0, 72), state: row.status })), [] as ListRow[]);
  },
  operator: { terminalOnly: 'Work contracts are kept by the terminal app that runs them.' },
});
const RUNNING = defineList<CommandActionContext>({
  name: 'agents.running',
  async read(ctx) {
    return readable(installed?.contracts, (contracts) => contracts.running(ctx).map((row): ListRow => ({ value: row.id, label: row.task.slice(0, 72), state: row.status })), [] as ListRow[]);
  },
  operator: { terminalOnly: 'Agents run in the terminal app that started them.' },
});
const GROUPS = defineList<CommandActionContext>({
  name: 'agents.groups',
  async read(ctx) {
    return readable(installed?.contracts, (contracts) => {
      const counts = new Map<string, number>();
      for (const row of contracts.running(ctx)) if (row.graphId) counts.set(row.graphId, (counts.get(row.graphId) ?? 0) + 1);
      return [...counts].map(([graphId, count]): ListRow => ({ value: graphId, label: graphId, state: `${count} running` }));
    }, [] as ListRow[]);
  },
  operator: { terminalOnly: 'Agents run in the terminal app that started them.' },
});
const ARCHETYPES = defineList<CommandActionContext>({
  name: 'agents.archetypes',
  async read(ctx) {
    return readable(installed?.team, (team) => team.archetypes(ctx).map((row): ListRow => ({ value: row.id, label: row.id, detail: row.label, state: row.issues > 0 ? `${row.issues} problem${row.issues === 1 ? '' : 's'}` : row.family })), [] as ListRow[]);
  },
  operator: { terminalOnly: 'Archetypes are read from this project\'s agents folder by the terminal app.' },
});

const TITLE: InputDescription = textInput({ id: 'title', label: 'What to do', help: 'The task, the way you would ask in the chat', why: 'your own words for the task', kind: 'long-text', typed: { tail: true } });
const TERMINAL_ONLY = { terminalOnly: 'It runs in the terminal app\'s session.' } as const;

type AgentsAction = ActionDescription<CommandActionContext>;

function start(fields: Pick<AgentsAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'>): AgentsAction {
  return { done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', operator: TERMINAL_ONLY, ...fields };
}

export const AGENTS_COMMAND: CommandDescription<CommandActionContext> = {
  name: 'agents',
  // --yes confirms only right after the action word: the same word in the text is text.
  leadingFlagsOnly: true,
  title: 'Your agents',
  summary: 'What your agents are doing: open the live view, start agents, host a coding agent, hand work on, and stop work',
  group: 'Agents and work',
  firstScreenRows: [
    'open',
    { label: 'Start agents…', actions: ['team', 'start', 'recipe', 'archetypes', 'archetype', 'start-archetype'] },
    { label: 'Host a coding agent…', actions: ['hostable', 'host'] },
    { label: 'Hand coding work to the terminal app…', actions: ['hand-off', 'handed-off'] },
    { label: 'Work contracts and stopping agents…', actions: ['contract', 'contracts-view', 'stop-group', 'stop-branch'] },
  ],
  actions: [
    doAction<CommandActionContext>({
      id: 'open', label: 'Open Your agents', word: 'open', touches: 'reads',
      inputs: [textInput({ id: 'target', label: 'Select', help: 'A process to select in the view, as id or id:kind', why: 'an id the view shows', typed: { flag: '--target' }, optional: { default: '', means: 'nothing selected' } })],
      sentence: 'Opens the live view of what is running, what waits for you and what is scheduled.',
      operator: { terminalOnly: 'It is a terminal screen; the web UI shows the same on its Agents page.' },
      async run(values, ctx) { hostOf().openPanel(ctx, values.target ?? ''); },
    }),
    readAction<CommandActionContext>({
      id: 'hostable', label: 'See coding agents you can host', word: 'hostable',
      sentence: 'Lists the third-party coding agents found on this machine (Claude Code, Codex, opencode) that can be hosted.',
      operator: { method: 'acp.agents.list', fields: {} },
      async run(_values, ctx) {
        const agents = await able(hostOf().coding).list(ctx);
        if (agents.length === 0) return 'No third-party coding agents found. Install Claude Code, Codex or opencode on PATH to host one.';
        return ['Coding agents you can host (/agents host <id>):', ...agents.map((agent) => `  ${agent.id}: ${agent.title}  (${agent.binaryPath})`)].join('\n');
      },
    }),
    start({
      id: 'host', label: 'Host a coding agent', word: 'host',
      inputs: [
        listInput({ id: 'agent', label: 'Coding agent', help: 'The coding agents found on this machine', list: HOSTABLE }),
        textInput({ id: 'directory', label: 'Folder', help: 'Where it works', why: 'a folder on this machine', kind: 'path', typed: { position: 2 }, optional: { default: '', means: 'the current folder' } }),
      ],
      sentence: '{agent} starts as a long-running session in the folder given and shows as a row in Your agents, where you steer and stop it.', example: { agent: 'claude-code' },
      async run(values, ctx) { return able(hostOf().coding).host(ctx, values.agent!, values.directory ?? ''); },
    }),
    readAction<CommandActionContext>({
      id: 'team', label: 'See team modes and recipes', word: 'team',
      sentence: 'Shows the team modes and recipes you can start agents from, with the tasks running now.',
      operator: TERMINAL_ONLY,
      async run(_values, ctx) { return able(hostOf().team).review(ctx); },
    }),
    start({
      id: 'start', label: 'Start an agent in a team mode', word: 'start',
      inputs: [choiceInput({ id: 'mode', label: 'Kind of agent', help: 'What it does', choices: TEAM_MODES, typed: { position: 1 } }), TITLE],
      sentence: 'An agent ({mode}) starts on "{title}" in this session; Your agents shows its progress.', example: { mode: 'research', title: 'compare the two parsers' },
      async run(values, ctx) { return able(hostOf().team).startMode(ctx, values.mode!, values.title!); },
    }),
    start({
      id: 'recipe', label: 'Run a recipe of agents', word: 'recipe',
      inputs: [choiceInput({ id: 'recipe', label: 'Recipe', help: 'Agents that run one after another, each handed the last one\'s report', choices: TEAM_RECIPES.map((recipe): FixedChoice => ({ value: recipe.value, label: recipe.label, help: recipe.help })), typed: { position: 1 } }), TITLE],
      sentence: 'The {recipe} recipe runs on "{title}": each step starts when the one before it finished, and a step that fails stops the rest.', example: { recipe: 'research-implement-review', title: 'add retries to the uploader' },
      async run(values, ctx) { return able(hostOf().team).runRecipe(ctx, values.recipe!, values.title!); },
    }),
    readAction<CommandActionContext>({
      id: 'archetypes', label: 'See agent archetypes', word: 'archetypes',
      sentence: 'Lists the built-in and project agent archetypes, their family, and any that have problems to fix.',
      operator: TERMINAL_ONLY,
      async run(_values, ctx) {
        const rows = able(hostOf().team).archetypes(ctx);
        if (rows.length === 0) return 'No agent archetypes found.';
        return ['Agent archetypes', ...rows.map((row) => `  ${row.id.padEnd(18)} ${row.family.padEnd(10)} ${row.label}${row.issues > 0 ? `  (${row.issues} problem${row.issues === 1 ? '' : 's'}: /agents archetype ${row.id})` : ''}`)].join('\n');
      },
    }),
    readAction<CommandActionContext>({
      id: 'archetype', label: 'See one archetype', word: 'archetype',
      inputs: [listInput({ id: 'archetype', label: 'Archetype', help: 'Built-in and project archetypes', list: ARCHETYPES })],
      sentence: 'Shows archetype {archetype}: its family, how it works, its tools, where it is defined and its problems.', example: { archetype: 'engineer' },
      operator: TERMINAL_ONLY,
      async run(values, ctx) { return able(hostOf().team).archetypeReport(ctx, values.archetype!); },
    }),
    start({
      id: 'start-archetype', label: 'Start an agent from an archetype', word: 'start-archetype',
      inputs: [listInput({ id: 'archetype', label: 'Archetype', help: 'Built-in and project archetypes', list: ARCHETYPES }), TITLE],
      sentence: 'An agent from archetype {archetype} starts on "{title}" in this session; Your agents shows its progress.', example: { archetype: 'engineer', title: 'fix the flaky upload' },
      async run(values, ctx) { return able(hostOf().team).startArchetype(ctx, values.archetype!, values.title!); },
    }),
    start({
      id: 'hand-off', label: 'Hand coding work to the terminal app', word: 'hand-off',
      inputs: [
        textInput({ id: 'task', label: 'The work', help: 'What to build, fix or review, in full', why: 'your own words for the work', kind: 'long-text', typed: { tail: true } }),
        choiceInput({ id: 'review', label: 'Reviewed', help: 'Whether the terminal app has its work reviewed', choices: [{ value: 'no', label: 'No review asked' }, { value: 'yes', label: 'Review the work too' }], typed: { flag: '--review', switchOn: 'yes' }, optional: { default: 'no', means: 'no review asked' } }),
        textInput({ id: 'reason', label: 'Why', help: 'Why it goes to the terminal app', why: 'your own words', typed: { flag: '--reason' }, optional: { default: '', means: 'not given' } }),
        textInput({ id: 'success', label: 'Done when', help: 'What shows the work is right', why: 'your own words', typed: { flag: '--success' }, optional: { default: '', means: 'not given' } }),
        textInput({ id: 'workspace', label: 'Where', help: 'A project, folder or worktree to work in', why: 'a name or path', typed: { flag: '--workspace' }, optional: { default: '', means: 'not given' } }),
        textInput({ id: 'priority', label: 'Priority', help: 'How soon, or a deadline', why: 'your own words', typed: { flag: '--priority' }, optional: { default: '', means: 'not given' } }),
      ],
      sentence: '"{task}" goes to the terminal app as a new shared session on the connected host, which asks before it changes anything.', example: { task: 'fix the failing upload test', review: 'yes' },
      async run(values, ctx) {
        return able(hostOf().handOff).send(ctx, {
          task: values.task!.trim(), reviewRequested: values.review === 'yes', reason: values.reason ?? '',
          successCriteria: values.success ?? '', workspaceHint: values.workspace ?? '', priority: values.priority ?? '',
        });
      },
    }),
    readAction<CommandActionContext>({
      id: 'handed-off', label: 'See work you handed off', word: 'handed-off',
      inputs: [listInput({ id: 'session', label: 'Hand-off', help: 'Work you handed to the terminal app, newest first', list: HANDED_OFF, other: 'a session id', optional: { default: '', means: 'all of them' } })],
      sentence: 'Shows the work you handed off {session}, with its session, whether it was taken, and its latest answer.', example: { session: 'session-1a2b' },
      operator: { terminalOnly: 'Hand-offs are recorded in the Agent\'s own home.' },
      async run(values, ctx) {
        const handOff = able(hostOf().handOff);
        if (values.session) return handOff.status(ctx, values.session);
        const all = handOff.recorded(ctx);
        if (all.length === 0) return 'No work handed off yet. Hand some on: /agents hand-off <the work>.';
        return [
          `Work handed off (${all.length}, newest first)`,
          ...all.slice(0, 10).map((entry) => `  ${entry.sessionId}  ${entry.createdAt.slice(0, 16).replace('T', ' ')}  ${entry.task.replace(/\s+/g, ' ').slice(0, 72)}`),
          ...(all.length > 10 ? [`  ... and ${all.length - 10} older`] : []),
          '  /agents handed-off <session> shows one hand-off\'s progress and answer.',
        ].join('\n');
      },
    }),
    readAction<CommandActionContext>({
      id: 'contract', label: 'See a work contract', word: 'contract',
      inputs: [listInput({ id: 'contract', label: 'Contract', help: 'Work contracts, newest first', list: CONTRACTS, other: 'a contract id', optional: { default: '', means: 'the newest' } })],
      sentence: 'Shows work contract {contract}: what was asked, its state, and its groups and units.', example: { contract: 'contract-1a2b' },
      operator: TERMINAL_ONLY,
      async run(values, ctx) { return able(hostOf().contracts).show(ctx, values.contract ?? ''); },
    }),
    doAction<CommandActionContext>({
      id: 'contracts-view', label: 'Open the work contracts view', word: 'contracts-view', touches: 'reads',
      sentence: 'Opens the full-screen view of work contracts and the agents running them.',
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(_values, ctx) { able(hostOf().contracts).openView(ctx); },
    }),
    {
      id: 'stop-group', label: 'Stop a group of agents', word: 'stop-group',
      inputs: [listInput({ id: 'group', label: 'Group', help: 'Groups with agents running', list: GROUPS, other: 'a group id' })],
      sentence: 'Every agent still running in group {group} is stopped.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'cannot-be-undone', operator: TERMINAL_ONLY, example: { group: 'graph-1a2b' },
      async run(values, ctx) { return able(hostOf().contracts).stopGroup(ctx, values.group!); },
    },
    {
      id: 'stop-branch', label: 'Stop an agent and the agents it started', word: 'stop-branch',
      inputs: [listInput({ id: 'agent', label: 'Agent', help: 'Agents running now', list: RUNNING, other: 'an agent id' })],
      sentence: 'Agent {agent} and every agent it started, and they started, are stopped.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'cannot-be-undone', operator: TERMINAL_ONLY, example: { agent: 'agent-1a2b' },
      async run(values, ctx) { return able(hostOf().contracts).stopBranch(ctx, values.agent!); },
    },
  ],
};

const AGENTS_SLASH_COMMAND = defineCommand(AGENTS_COMMAND);

/** Register `/agents` (the one description) with this app's host. */
export function registerAgentsCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: AgentsHost<Ctx>): void {
  installed = host as unknown as AgentsHost<CommandActionContext>;
  registry.register(AGENTS_SLASH_COMMAND as never);
}

