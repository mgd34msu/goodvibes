/**
 * `/health` and `/status`, described once (command-actions/) for both
 * terminal apps.
 *
 * `/health` is the one place for "is everything working": bare, it prints the
 * short status report (`✓ Everything is working.`, or one line per thing that
 * is not with the line that fixes it); "Check an area" shows one area in
 * detail; "Describe a problem" runs the runbook for a symptom. The failure
 * reports of this session (what `/forensics` and `/incident` showed), the
 * runtime store (`/state`), the connected host's compatibility (the Agent's
 * `/compat`) and stopping a running agent (`/ops agent cancel`) are its
 * actions too. `/status` stays its own one-action command.
 *
 * What each app does is its policy, read by the actions' `run`; an action an
 * app does not have is refused with where it is.
 */
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandReport, FixedChoice, InputDescription } from './command-actions/types.js';
import { choiceInput, readAction, textInput } from './described-command-kit.js';

/** The areas "Check an area" offers, the same list in both apps. */
export type HealthArea =
  | 'setup' | 'services' | 'provider' | 'accounts' | 'auth' | 'settings' | 'intelligence' | 'remote' | 'mcp'
  | 'memory' | 'metrics' | 'continuity' | 'worktrees' | 'maintenance' | 'sandbox' | 'terminal' | 'approvals';

export const HEALTH_AREAS: readonly (FixedChoice & { readonly value: HealthArea })[] = [
  { value: 'setup', label: 'Setup', help: 'Models, services, plugins and MCP servers found at start' },
  { value: 'services', label: 'Services', help: 'Whether each configured service is ready' },
  { value: 'provider', label: 'Model providers', help: 'The model in use and provider account problems' },
  { value: 'accounts', label: 'Provider accounts', help: 'Sign-ins and keys of each provider' },
  { value: 'auth', label: 'Local sign-in', help: 'Users and sessions of this machine\'s sign-in' },
  { value: 'settings', label: 'Settings', help: 'Managed locks, conflicts and failed writes' },
  { value: 'intelligence', label: 'Code intelligence', help: 'Language servers, symbols and diagnostics' },
  { value: 'remote', label: 'Remote runners', help: 'Remote sessions and their connections' },
  { value: 'mcp', label: 'MCP servers', help: 'Which servers are connected and which failed' },
  { value: 'memory', label: 'Memory use', help: 'This program\'s memory budget, caches and paused work' },
  { value: 'metrics', label: 'Runtime counters and quota', help: 'The daemon\'s counters and the provider\'s remaining quota' },
  { value: 'continuity', label: 'Picking up where you left off', help: 'The last session and the recovery file' },
  { value: 'worktrees', label: 'Worktrees', help: 'Worktrees kept, active or paused' },
  { value: 'maintenance', label: 'Conversation size', help: 'How full the context window is and whether to compact' },
  { value: 'sandbox', label: 'Sandbox', help: 'Whether commands and MCP servers run inside a boundary' },
  { value: 'terminal', label: 'This terminal', help: 'Colours, synchronized output and intercepted writes' },
  { value: 'approvals', label: 'Approvals waiting', help: 'The asks waiting for you on the host and here' },
];

/** What `/forensics` and `/incident` read: this session's failure reports. */
interface FailureReportRecord {
  readonly id: string;
  readonly classification: string;
  readonly summary: string;
  readonly generatedAt: number;
}
interface FailureReportsHolder {
  readonly extensions?: { readonly forensicsRegistry?: { getAll(): readonly FailureReportRecord[] } | null | undefined } | undefined;
}
interface RunningAgentsHolder {
  readonly ops?: { readonly agentManager?: { list(): readonly { readonly id: string; readonly task: string; readonly status: string }[] } | null | undefined } | undefined;
}

const FAILURE_REPORTS = defineList<CommandActionContext>({
  name: 'health.failure-reports',
  async read(ctx) {
    const registry = (ctx as CommandActionContext & FailureReportsHolder).extensions?.forensicsRegistry;
    if (!registry) return [];
    return [...registry.getAll()].sort((a, b) => b.generatedAt - a.generatedAt).map((report): ListRow => ({
      value: report.id, label: report.summary || report.classification,
      detail: `${report.classification} · ${new Date(report.generatedAt).toLocaleString()}`,
    }));
  },
  operator: { terminalOnly: 'Failure reports are kept by the terminal app for its own session.' },
});

const RUNNING_AGENTS = defineList<CommandActionContext>({
  name: 'health.running-agents',
  async read(ctx) {
    const manager = (ctx as CommandActionContext & RunningAgentsHolder).ops?.agentManager;
    if (!manager) return [];
    return manager.list().filter((agent) => agent.status === 'running' || agent.status === 'pending').map((agent): ListRow => ({
      value: agent.id, label: agent.task.length > 60 ? `${agent.task.slice(0, 57)}...` : agent.task, state: agent.status,
    }));
  },
  operator: { terminalOnly: 'The agents are the terminal app\'s own.' },
});

export type FailureReportView = 'summary' | 'report' | 'bundle';

/** What each app does for `/health`. An optional part an app does not have is refused with `elsewhere`. */
export interface HealthCommandPolicy<Ctx> {
  /** The short status: everything working, or each thing that is not with the line that fixes it. */
  readonly report: (ctx: Ctx) => Promise<CommandReport>;
  /** One area in detail; refuses an area this app does not check. */
  readonly check: (ctx: Ctx, area: HealthArea, provider: string) => Promise<string>;
  /** The runbook for a symptom, run against this app's live state (no model request). */
  readonly diagnose: (ctx: Ctx, symptom: string) => Promise<string>;
  /** The runtime store by domain, credentials masked. */
  readonly runtimeState: (ctx: Ctx, domains: readonly string[]) => string;
  /** The connected host's compatibility, where this app has one. */
  readonly compat?: ((ctx: Ctx, json: boolean) => Promise<string>) | undefined;
  readonly failures?: {
    show(ctx: Ctx, report: string, view: FailureReportView): string;
    save(ctx: Ctx, input: { readonly report: string; readonly path: string; readonly replay: boolean; readonly replace: boolean }): string;
    keep(ctx: Ctx, report: string): Promise<string>;
  } | undefined;
  readonly stopAgent?: ((ctx: Ctx, agentId: string, note: string) => Promise<string>) | undefined;
  /** Where the parts this app lacks are: "the terminal app (goodvibes)". */
  readonly elsewhere: string;
}

const REPORT_INPUT: InputDescription = {
  id: 'report', label: 'Failure report', help: 'This session\'s failure reports, newest first', kind: 'choice',
  choices: { list: FAILURE_REPORTS, allowOther: { reason: 'a report id, or latest' } },
  required: { default: 'latest', defaultMeans: 'the latest one' }, typed: { position: 1 },
};

function healthActions<Ctx extends CommandActionContext>(policy: HealthCommandPolicy<Ctx>): ActionDescription<Ctx>[] {
  const notHere = (what: string): never => {
    throw commandRefusal(`${what} is not in this program; nothing was done.`, `It is in ${policy.elsewhere}.`);
  };
  const failures = () => policy.failures ?? notHere('Failure reports');
  return [
    readAction<Ctx>({
      id: 'report', label: 'See what needs attention', word: 'report',
      sentence: 'Checks setup, providers, accounts, settings, services, MCP servers, sign-in and the conversation\'s size, and names each thing that is not working with the line that fixes it.',
      async run(_values, ctx) { return policy.report(ctx); },
    }),
    readAction<Ctx>({
      id: 'check', label: 'Check one area', word: 'check',
      inputs: [
        choiceInput({ id: 'area', label: 'Area', help: 'What to look at in detail', choices: HEALTH_AREAS, typed: { position: 1 } }),
        {
          ...textInput({ id: 'provider', label: 'Provider', help: 'Whose remaining quota to read', why: 'a provider\'s id', typed: { flag: '--provider' }, optional: { default: '', means: 'the provider in use' } }),
          showWhen: { input: 'area', is: 'metrics' },
        },
      ],
      sentence: 'Shows {area} in detail: what is set up, what is working and what is not.',
      example: { area: 'mcp' },
      async run(values, ctx) { return policy.check(ctx, values.area as HealthArea, values.provider ?? ''); },
    }),
    readAction<Ctx>({
      id: 'diagnose', label: 'Describe a problem', word: 'diagnose',
      inputs: [textInput({ id: 'symptom', label: 'What is wrong', help: 'In your own words, such as "stuck turn"', why: 'your own words', typed: { tail: true } })],
      sentence: 'Finds the checks for {symptom} and runs them against this program\'s live state; no model is asked.',
      example: { symptom: 'stuck turn' },
      async run(values, ctx) { return policy.diagnose(ctx, values.symptom!); },
    }),
    readAction<Ctx>({
      id: 'failure', label: 'See a failure report', word: 'failure',
      inputs: [
        REPORT_INPUT,
        choiceInput({
          id: 'view', label: 'As', help: 'How much to show', typed: { flag: '--as' },
          choices: [
            { value: 'summary', label: 'A summary', help: 'What failed, why, and the evidence counts' },
            { value: 'report', label: 'The report as JSON' },
            { value: 'bundle', label: 'The whole bundle as JSON', help: 'With the replay snapshot, for a support thread' },
          ],
          optional: { default: 'summary', means: 'a summary' },
        }),
      ],
      sentence: 'Shows a failure report of this session: what failed, its cause and the evidence.',
      example: { report: 'latest', view: 'report' },
      async run(values, ctx) { return failures().show(ctx, values.report || 'latest', (values.view || 'summary') as FailureReportView); },
    }),
    {
      id: 'save-failure', label: 'Save a failure report as a file', word: 'save-failure',
      inputs: [
        textInput({ id: 'path', label: 'File', help: 'Where to write it', why: 'a file path', kind: 'path', typed: { position: 1 } }),
        { ...REPORT_INPUT, typed: { flag: '--report' } },
        choiceInput({
          id: 'replay', label: 'Replay snapshot', help: 'The recorded turn, to replay it elsewhere', typed: { flag: '--with-replay', switchOn: 'yes' },
          choices: [{ value: 'no', label: 'Leave it out' }, { value: 'yes', label: 'Put it in' }],
          optional: { default: 'no', means: 'leave it out' },
        }),
        choiceInput({
          id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', typed: { flag: '--replace', switchOn: 'yes' },
          choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
          optional: { default: 'no', means: 'keep it and stop' },
        }),
      ],
      sentence: 'The failure report\'s bundle will be written to {path} on this machine, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'Failure reports are kept by the terminal app for its own session.' },
      example: { path: 'incident.json', report: 'latest' },
      async run(values, ctx) {
        return failures().save(ctx, { report: values.report || 'latest', path: values.path!, replay: values.replay === 'yes', replace: values.replace === 'yes' });
      },
    },
    {
      id: 'keep-failure', label: 'Keep a failure report in memory', word: 'keep-failure',
      inputs: [REPORT_INPUT],
      sentence: 'The failure report is kept in durable memory as an incident record, once, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'Failure reports are kept by the terminal app for its own session.' },
      example: { report: 'latest' },
      async run(values, ctx) { return failures().keep(ctx, values.report || 'latest'); },
    },
    {
      id: 'stop-agent', label: 'Stop a running agent', word: 'stop-agent',
      inputs: [
        { id: 'agent', label: 'Agent', help: 'The agents running now', kind: 'choice', choices: { list: RUNNING_AGENTS, allowOther: { reason: 'an agent id' } }, required: true, typed: { position: 1 } },
        textInput({ id: 'note', label: 'Why', help: 'A note kept with the stop', why: 'your own words', kind: 'long-text', typed: { flag: '--note' }, optional: { default: '', means: 'no note' } }),
      ],
      sentence: 'Agent {agent} is stopped; what it has not finished is not done.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { terminalOnly: 'The agents are the terminal app\'s own.' },
      example: { agent: 'agent-1a2b' },
      async run(values, ctx) {
        if (!policy.stopAgent) return notHere('Stopping an agent');
        return policy.stopAgent(ctx, values.agent!, values.note ?? '');
      },
    },
    readAction<Ctx>({
      id: 'state', label: 'See the runtime store', word: 'state',
      inputs: [textInput({ id: 'domains', label: 'Parts', help: 'Only these parts, such as session agents tasks', why: 'part names as the store lists them', typed: { tail: true }, optional: { default: '', means: 'every part' } })],
      sentence: 'Shows what this program\'s runtime store holds now, part by part, with credentials masked; for debugging.',
      example: { domains: 'session' },
      async run(values, ctx) {
        return policy.runtimeState(ctx, (values.domains ?? '').split(/[\s,]+/).filter((name) => name.length > 0));
      },
    }),
    readAction<Ctx>({
      id: 'compat', label: 'Check the connected host\'s compatibility', word: 'compat',
      inputs: [choiceInput({
        id: 'format', label: 'As', help: 'Text, or JSON for programs', typed: { flag: '--json', switchOn: 'json' },
        choices: [{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }], optional: { default: 'text', means: 'text' },
      })],
      sentence: 'Asks the connected host which routes it serves and whether the Agent\'s knowledge routes are ready.',
      example: { format: 'json' },
      async run(values, ctx) {
        if (!policy.compat) return notHere('The connected-host compatibility check');
        return policy.compat(ctx, values.format === 'json');
      },
    }),
  ];
}

/** `/health` for one app. */
export function createHealthCommand<Ctx extends CommandActionContext>(policy: HealthCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'health',
    title: 'Health',
    summary: 'See whether everything is working, check one area, or find the cause of a problem',
    group: 'Health',
    report: 'report',
    firstScreenRows: [
      'report',
      'check',
      'diagnose',
      { label: 'Failure reports of this session…', actions: ['failure', 'save-failure', 'keep-failure'] },
      'stop-agent',
      { label: 'For debugging…', actions: ['state', 'compat'] },
    ],
    actions: healthActions(policy),
  });
}

/** `/status` for one app: one report of this session, what each app shows is its own. */
export function createStatusCommand<Ctx extends CommandActionContext>(status: (ctx: Ctx) => string): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'status',
    title: 'Status',
    summary: 'See this session at a glance: model, context window and what is in force',
    group: 'Health',
    actions: [
      readAction<Ctx>({
        id: 'status', label: 'See this session at a glance', word: '',
        sentence: 'Shows the model in use, its context window and where it came from, and the session\'s other states.',
        async run(_values, ctx) { return status(ctx); },
      }),
    ],
  });
}
