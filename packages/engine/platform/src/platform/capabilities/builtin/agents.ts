/**
 * Your agents (Work and agents). Two homes:
 *
 * - `session`: team modes, recipes and archetypes start agents in the
 *   conversation of the program holding it, and the agents running are that
 *   program's own (the terminal app runs them; the Agent has none, so these are
 *   not something it does). Work an agent hands over runs on the daemon (Work).
 * - `daemon`: the third-party coding agents (Claude Code, Codex, opencode) the
 *   daemon finds and hosts, through its own `acp.agents.list` and
 *   `acp.sessions.create` methods, run as the same caller.
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

export interface AgentArchetypeRow { readonly id: string; readonly label: string; readonly family: string; readonly issues: number }
export interface RunningAgentRow {
  readonly id: string; readonly task: string; readonly status: string; readonly graphId?: string | undefined;
  /** Its last progress line, and what went wrong when it failed: an ended agent's record, read on Your agents. */
  readonly progress?: string | undefined; readonly error?: string | undefined;
}

/** Team modes, recipes and archetypes, and starting agents from them, in this program's conversation. */
export interface AgentTeamServices {
  review(): string;
  archetypes(): readonly AgentArchetypeRow[];
  archetypeReport(name: string): string;
  startMode(mode: string, title: string): string;
  runRecipe(recipe: string, title: string): string;
  startArchetype(name: string, title: string): string;
}

/**
 * The agents this program started and stopping them. A delegation that once ran as a contract here is a piece of work
 * on the daemon now (Work, tools/agent/work-delegation.ts); its agent here follows it.
 */
export interface AgentContractServices {
  running(): readonly RunningAgentRow[];
  /** Every agent started in this session, the ended ones too (Your agents lists them, so their record can be read). */
  started(): readonly RunningAgentRow[];
  /** Stop one running agent, the note kept with the stop. */
  stop(agentId: string, note: string): string;
  stopGroup(graphId: string): string;
  stopBranch(agentId: string): string;
}

export interface AgentsCapabilityServices {
  /** Absent in a program that starts no agents of its own (the Agent). */
  readonly agentTeam?: AgentTeamServices | undefined;
  readonly agentContracts?: AgentContractServices | undefined;
  /** The Agent's briefing of its own state; absent in the terminal app. */
  readonly briefing?: { read(): string } | undefined;
}

/** `/brief`'s one action (id `work.brief`): the Agent's briefing of how it is set up and what to do next. */
export const WORK_BRIEF: CapabilityDefinition<AgentsCapabilityServices> = {
  capability: { id: 'work.brief', group: 'work', home: 'session', repeat: 'safe' },
  actionId: 'brief', label: 'See your briefing', word: '', inputs: [],
  sentence: 'Shows the model in use, what is ready (memory, skills, routines, channels, voice), the work plan and schedules, and what to do next.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.briefing !== undefined,
  async run(_values, services) {
    if (!services.briefing) throw new CapabilityRefusal('The briefing is the Agent\'s: this program keeps none.', 'Open the Work place in the Agent.', 'UNAVAILABLE');
    return { text: services.briefing.read() };
  },
};

/** The lists the inputs choose from (terminal-shell agents-command.ts reads them). */
export const AGENTS_HOSTABLE_LIST = 'agents.hostable' as ListName;
export const AGENTS_RUNNING_LIST = 'agents.running' as ListName;
export const AGENTS_GROUPS_LIST = 'agents.groups' as ListName;
export const AGENTS_ARCHETYPES_LIST = 'agents.archetypes' as ListName;

/** The team modes: what each starts. The terminal app keeps how each one runs. */
export const TEAM_MODES: readonly FixedChoice[] = [
  { value: 'local-engineer', label: 'An engineer here', help: 'Gathers, plans, then changes files in this project.' },
  { value: 'local-shell', label: 'A shell task here', help: 'Runs commands directly.' },
  { value: 'remote-engineer', label: 'An engineer on a remote runner', help: 'Started from the Runners tab of the Work place; listed here for the recipes that use it.' },
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

type SessionDefinition = CapabilityDefinition<AgentsCapabilityServices>;
type DaemonDefinition = CapabilityDefinition<Record<never, never>>;

const NOT_HERE = 'Starting agents of its own and stopping them belong to the terminal app, which runs them.';

function teamOf(services: AgentsCapabilityServices): AgentTeamServices {
  if (!services.agentTeam) throw new CapabilityRefusal(`Nothing was started: ${NOT_HERE}`, 'Open the Work place in the terminal app.', 'UNAVAILABLE');
  return services.agentTeam;
}
function contractsOf(services: AgentsCapabilityServices): AgentContractServices {
  if (!services.agentContracts) throw new CapabilityRefusal(`Nothing was done: ${NOT_HERE}`, 'Open the Work place in the terminal app.', 'UNAVAILABLE');
  return services.agentContracts;
}

const TITLE: InputDescription = { id: 'title', label: 'What to do', help: 'The task, the way you would ask in the chat', kind: 'long-text', freeTextReason: 'your own words for the task', required: true, typed: { tail: true } };
const ARCHETYPE: InputDescription = { id: 'archetype', label: 'Archetype', help: 'Built-in and project archetypes', kind: 'choice', choices: { list: AGENTS_ARCHETYPES_LIST }, required: true, typed: { position: 1 } };

function session(fields: Omit<SessionDefinition, 'capability' | 'word' | 'done' | 'lasts' | 'touches' | 'risk' | 'example' | 'available'> & {
  readonly touches?: SessionDefinition['touches']; readonly risk?: SessionDefinition['risk']; readonly example?: SessionDefinition['example']; readonly repeat: 'safe' | 'unsafe';
  readonly lasts?: SessionDefinition['lasts'];
}): SessionDefinition {
  const { repeat, ...rest } = fields;
  return {
    capability: { id: `agents.${fields.actionId}`, group: 'work', home: 'session', repeat },
    word: fields.actionId, done: '', touches: fields.touches ?? 'reads', lasts: fields.lasts ?? 'not-a-change', risk: fields.risk ?? 'none', example: fields.example ?? {},
    // The Agent starts no agents of its own: these are not offered there.
    available: (services) => services.agentTeam !== undefined || services.agentContracts !== undefined,
    ...rest,
  };
}

export const AGENTS_TEAM = session({
  actionId: 'team', label: 'See team modes and recipes', inputs: [], repeat: 'safe',
  sentence: 'Shows the team modes and recipes you can start agents from, with the tasks running now.',
  async run(_values, services) { return { text: teamOf(services).review() }; },
});

export const AGENTS_START = session({
  // It makes an agent, Your agents' kind of thing, listed for the session: the empty tab names this action first.
  actionId: 'start', label: 'Start an agent in a team mode', repeat: 'unsafe', touches: 'this-machine', lasts: 'session',
  inputs: [{ id: 'mode', label: 'Kind of agent', help: 'What it does', kind: 'choice', choices: TEAM_MODES, required: true, typed: { position: 1 } }, TITLE],
  sentence: 'An agent ({mode}) starts on "{title}"; Your agents shows its progress and its record, for this session only.', example: { mode: 'research', title: 'compare the two parsers' },
  async run(values, services) { return { text: teamOf(services).startMode(values.mode!, values.title!) }; },
});

export const AGENTS_RECIPE = session({
  actionId: 'recipe', label: 'Run a recipe of agents', repeat: 'unsafe', touches: 'this-machine',
  inputs: [{ id: 'recipe', label: 'Recipe', help: 'Agents that run one after another, each handed the last one\'s report', kind: 'choice', choices: TEAM_RECIPES.map((recipe): FixedChoice => ({ value: recipe.value, label: recipe.label, help: recipe.help })), required: true, typed: { position: 1 } }, TITLE],
  sentence: 'The {recipe} recipe runs on "{title}": each step starts when the one before it finished, and a step that fails stops the rest.', example: { recipe: 'research-implement-review', title: 'add retries to the uploader' },
  async run(values, services) { return { text: teamOf(services).runRecipe(values.recipe!, values.title!) }; },
});

export const AGENTS_ARCHETYPES = session({
  actionId: 'archetypes', label: 'See agent archetypes', inputs: [], repeat: 'safe',
  sentence: 'Lists the built-in and project agent archetypes, their family, and any that have problems to fix.',
  async run(_values, services) {
    const rows = teamOf(services).archetypes();
    if (rows.length === 0) return { text: 'No agent archetypes found.', data: { archetypes: [] } };
    return {
      text: ['Agent archetypes', ...rows.map((row) => `  ${row.id.padEnd(18)} ${row.family.padEnd(10)} ${row.label}${row.issues > 0 ? `  (${row.issues} problem${row.issues === 1 ? '' : 's'})` : ''}`)].join('\n'),
      data: { archetypes: rows },
    };
  },
});

export const AGENTS_ARCHETYPE = session({
  actionId: 'archetype', label: 'See one archetype', inputs: [ARCHETYPE], repeat: 'safe',
  sentence: 'Shows archetype {archetype}: its family, how it works, its tools, where it is defined and its problems.', example: { archetype: 'engineer' },
  async run(values, services) { return { text: teamOf(services).archetypeReport(values.archetype!) }; },
});

export const AGENTS_START_ARCHETYPE = session({
  actionId: 'start-archetype', label: 'Start an agent from an archetype', repeat: 'unsafe', touches: 'this-machine', inputs: [ARCHETYPE, TITLE],
  sentence: 'An agent from archetype {archetype} starts on "{title}" in this session; Your agents shows its progress.', example: { archetype: 'engineer', title: 'fix the flaky upload' },
  async run(values, services) { return { text: teamOf(services).startArchetype(values.archetype!, values.title!) }; },
});

export const AGENTS_STOP_GROUP = session({
  actionId: 'stop-group', label: 'Stop a group of agents', repeat: 'safe', touches: 'this-machine', risk: 'cannot-be-undone',
  inputs: [{ id: 'group', label: 'Group', help: 'Groups with agents running', kind: 'choice', choices: { list: AGENTS_GROUPS_LIST, allowOther: { reason: 'a group id' } }, required: true, typed: { position: 1 } }],
  sentence: 'Every agent still running in the group {group} is stopped.', example: { group: 'graph-1a2b' },
  async run(values, services) { return { text: contractsOf(services).stopGroup(values.group!) }; },
});

/** Stopping one running agent (`x` in Your agents), with a note kept with the stop. */
export const AGENTS_STOP = session({
  actionId: 'stop', label: 'Stop one of the agents you started', repeat: 'safe', touches: 'this-machine', risk: 'cannot-be-undone',
  inputs: [
    { id: 'agent', label: 'Agent', help: 'Agents running now', kind: 'choice', choices: { list: AGENTS_RUNNING_LIST, allowOther: { reason: 'an agent id' } }, required: true, typed: { position: 1 } },
    { id: 'note', label: 'Why', help: 'A note kept with the stop', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { flag: '--note' } },
  ],
  sentence: 'Agent {agent} is stopped; what it has not finished is not done.', example: { agent: 'agent-1a2b' },
  async run(values, services) { return { text: contractsOf(services).stop(values.agent!, values.note ?? '') }; },
});

export const AGENTS_STOP_BRANCH = session({
  actionId: 'stop-branch', label: 'Stop an agent and every agent it spawned', repeat: 'safe', touches: 'this-machine', risk: 'cannot-be-undone',
  inputs: [{ id: 'agent', label: 'Agent', help: 'Agents running now', kind: 'choice', choices: { list: AGENTS_RUNNING_LIST, allowOther: { reason: 'an agent id' } }, required: true, typed: { position: 1 } }],
  sentence: 'Agent {agent} and every agent it spawned, and they spawned, are stopped.', example: { agent: 'agent-1a2b' },
  async run(values, services) { return { text: contractsOf(services).stopBranch(values.agent!) }; },
});

// ---------------------------------------------------------------------------
// The coding agents the daemon hosts (its own acp.* methods).
// ---------------------------------------------------------------------------

function methodOf(caller: CapabilityCaller): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal('This runs on the daemon, through capabilities.run.');
  return caller.method;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';

export const AGENTS_HOSTABLE: DaemonDefinition = {
  capability: { id: 'agents.hostable', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'hostable', label: 'See coding agents you can host', word: 'hostable', inputs: [],
  sentence: 'Lists the third-party coding agents found on this machine (Claude Code, Codex, opencode) that can be hosted.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, _services, caller) {
    const listed = record(await methodOf(caller)('acp.agents.list', {}))['agents'];
    const agents = (Array.isArray(listed) ? listed : []).map(record)
      .map((agent) => ({ id: plain(agent['id']), title: plain(agent['title']) || plain(agent['id']), binaryPath: plain(agent['binaryPath']) })).filter((agent) => agent.id);
    if (agents.length === 0) return { text: 'No third-party coding agents found. Install Claude Code, Codex or opencode on PATH to host one.', data: { agents } };
    return { text: ['Coding agents you can host', ...agents.map((agent) => `  ${agent.id}: ${agent.title}  (${agent.binaryPath})`)].join('\n'), data: { agents } };
  },
};

export const AGENTS_HOST: DaemonDefinition = {
  capability: { id: 'agents.host', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'host', label: 'Host a coding agent', word: 'host',
  inputs: [
    { id: 'agent', label: 'Coding agent', help: 'The coding agents found on this machine', kind: 'choice', choices: { list: AGENTS_HOSTABLE_LIST }, required: true, typed: { position: 1 } },
    { id: 'directory', label: 'Folder', help: 'Where it works', kind: 'path', freeTextReason: 'a folder on this machine', required: { default: '', defaultMeans: 'the current folder' }, typed: { position: 2 } },
  ],
  sentence: '{agent} starts as a long-running session in the folder given; it is listed in the Sessions place as a shared session, where you send it work and close it.',
  // Another coding agent, long-running in that folder, that runs its own tools under its own rules, not this gate's:
  // it loosens a protection.
  done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'loosens-a-protection', example: { agent: 'claude-code' },
  async run(values, _services, caller) {
    const cwd = values.directory || caller.workingDirectory;
    if (!cwd) throw new CapabilityRefusal('Nothing was started: no folder was given and the caller named none.', 'Give the folder it works in.');
    const answer = record(await methodOf(caller)('acp.sessions.create', { agentId: values.agent!, cwd }));
    const hosted = record(answer['hosted']);
    const failure = record(hosted['error']);
    const title = plain(hosted['title']) || values.agent!;
    // The hosted session's title is "<agent>: <folder>"; the sentence names the folder once.
    const named = title.endsWith(`: ${cwd}`) ? title.slice(0, -(cwd.length + 2)) : title;
    if (hosted['error']) throw new CapabilityRefusal(`Could not host ${named}: the ${plain(failure['stage'])} stage failed for ${plain(failure['binary'])}; ${plain(failure['message'])}`);
    return {
      text: `Hosting ${named} in ${cwd}${answer['started'] === false ? ' (queued)' : ''}; it is listed in the Sessions place as a shared session, where you send it work and close it.`,
      data: { hosted: { id: hosted['id'], title, state: hosted['state'] }, started: answer['started'] !== false },
    };
  },
};
