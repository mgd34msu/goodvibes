/**
 * `/triggers`, described once (command-actions/): both terminal apps register
 * this one description against the selected daemon's supervised triggers,
 * reached through its retained paired connection. "Watch for something" is a
 * form (what to watch, how often, what to do when it happens), never a JSON
 * definition. Letting triggers run a command is the owner's own act: it
 * loosens a protection, so a model's line is refused and the owner is asked.
 */
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { normalizeEverySchedule } from '@goodvibes-jev/engine/platform/platform/automation';
import { readTriggerOperatorStatus, TRIGGER_OPERATOR_MESSAGES, type TriggerOperatorFailureKind } from '@goodvibes-jev/engine/platform/platform/triggers/browser';
import { describeRetainedConnectionFailure, RetainedOperatorConnection } from './retained-operator-connection.js';
import { isOwnerOperatorPrincipal } from './native/native-paired-principal.js';
import type { PaymentWindowCommandContext, PaymentWindowCommandPolicy } from './payment-window-command.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';

const display = (value: unknown) => stripDangerousAnsi(String(value ?? '')).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export interface TriggerCommandContext extends CommandActionContext, PaymentWindowCommandContext {
  readonly renderRequest: () => void;
}

let installedPolicy: PaymentWindowCommandPolicy<TriggerCommandContext> | undefined;
function policyOf(): PaymentWindowCommandPolicy<TriggerCommandContext> {
  if (!installedPolicy) throw commandRefusal('Triggers are not available in this session.');
  return installedPolicy;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** One trigger as a line: label, id, kind, state, what it watches and how often it fired. */
function triggerLine(trigger: Record<string, unknown>): string {
  const parts = [`  ${display(trigger['label'])} (${display(trigger['id'])}): ${display(trigger['kind'])}, ${display(trigger['state'])}`];
  if (trigger['watching'] !== undefined) parts.push(`watching ${display(trigger['watching'])}`);
  if (typeof trigger['firedCount'] === 'number') parts.push(`fired ${trigger['firedCount']}`);
  if (trigger['lastError'] !== undefined) parts.push(`last error: ${display(trigger['lastError'])}`);
  if (trigger['next'] !== undefined) parts.push(`next: ${display(trigger['next'])}`);
  return parts.join(' · ');
}

/** The daemon's own words for a refused operation, or the failure's message. */
function describeFailure(error: unknown): string {
  if (error instanceof GoodVibesError) {
    const body = record(error.body);
    const message = body['error'] ?? body['message'];
    if (typeof message === 'string' && message.length > 0) return display(message);
  }
  return display(error instanceof Error ? error.message : String(error));
}

/**
 * Run one or more method calls on the selected daemon as its owner, with the
 * watcher scope the work needs. A failure is refused in the daemon's words.
 */
async function onDaemon<T>(
  ctx: TriggerCommandContext,
  writes: boolean,
  what: string,
  work: (invoke: (methodId: string, body: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const policy = policyOf();
  const abort = new AbortController();
  let connection: RetainedOperatorConnection;
  try {
    connection = new RetainedOperatorConnection({
      owner: () => policy.owner(ctx), home: () => policy.home(ctx),
      read: (observation) => policy.read(ctx, observation), files: policy.files,
      environment: policy.environment, fetchImpl: policy.fetchImpl, signal: abort.signal,
    });
  } catch (error) {
    throw commandRefusal(`${what} was not done: ${describeRetainedConnectionFailure(error, 'try again')}`);
  }
  const scope = writes ? 'write:watchers' : 'read:watchers';
  const invoke = (methodId: string, body: Record<string, unknown>) => connection.run(async (operator, signal) => operator.transport.requestJson(
    `/api/control-plane/methods/${methodId}/invoke`, { method: 'POST', body: { body }, signal, retry: false },
  ));
  try {
    const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
    if (!isOwnerOperatorPrincipal(auth, [scope], connection.expectedPrincipalId)) throw commandRefusal(`${what} was not done: the selected daemon does not give this terminal the owner's watcher credential (${scope}).`);
    return await work(invoke);
  } catch (error) {
    if (error instanceof Error && error.name === 'RefusalError') throw error;
    throw commandRefusal(`${what} was not done: ${describeFailure(error)}`);
  } finally {
    abort.abort();
    void connection.close();
  }
}

async function listTriggers(ctx: TriggerCommandContext): Promise<{ readonly triggers: readonly Record<string, unknown>[]; readonly otherProcess: boolean }> {
  return onDaemon(ctx, false, 'Reading the triggers', async (invoke) => {
    const body = record(await invoke('watchers.triggers.list', {}));
    return { triggers: Array.isArray(body['triggers']) ? body['triggers'].map(record) : [], otherProcess: body['ownership'] === 'other-process' };
  });
}

async function listGrants(ctx: TriggerCommandContext): Promise<readonly Record<string, unknown>[]> {
  return onDaemon(ctx, false, 'Reading the commands triggers may run', async (invoke) => {
    const body = record(await invoke('watchers.triggers.grant.list', {}));
    return Array.isArray(body['grants']) ? body['grants'].map(record) : [];
  });
}

function argvOf(grant: Record<string, unknown>): string {
  return [grant['command'], ...(Array.isArray(grant['args']) ? grant['args'] : [])].map(display).join(' ');
}

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

const TRIGGERS = defineList<TriggerCommandContext>({
  name: 'triggers',
  async read(ctx) {
    return (await listTriggers(ctx)).triggers.map((trigger): ListRow => ({
      value: display(trigger['id']), label: display(trigger['label']),
      ...(trigger['watching'] !== undefined ? { detail: `watching ${display(trigger['watching'])}` } : {}),
      state: display(trigger['state']),
    }));
  },
  operator: { method: 'watchers.triggers.list', input: {}, rows: { from: 'triggers', value: 'id', label: 'label', detail: 'watching', state: 'state' } },
});

const GRANTS = defineList<TriggerCommandContext>({
  name: 'triggers.commands',
  async read(ctx) {
    return (await listGrants(ctx)).map((grant): ListRow => ({ value: display(grant['id']), label: display(grant['id']), detail: argvOf(grant) }));
  },
  operator: { method: 'watchers.triggers.grant.list', input: {}, rows: { from: 'grants', value: 'id', label: 'id', detail: 'command' } },
});

const TRIGGER: InputDescription = {
  id: 'trigger', label: 'Trigger', help: 'The triggers on the selected daemon', kind: 'choice', choices: { list: TRIGGERS }, required: true, typed: { position: 1 },
};

// ---------------------------------------------------------------------------
// "Watch for something": what to watch, how often, what to do
// ---------------------------------------------------------------------------

const WATCH_KINDS: readonly FixedChoice[] = [
  { value: 'finishes', label: 'A command finishing', help: 'Start a command and act when it ends, however it ends.' },
  { value: 'prints', label: 'A line a command prints', help: 'Keep a command running and act on each line that matches.' },
  { value: 'page', label: 'A web address changing', help: 'Fetch it every so often and act when it is different.' },
  { value: 'file', label: 'A file changing', help: 'Look at it every so often and act when it is different.' },
];

const THEN: readonly FixedChoice[] = [
  { value: 'ask', label: 'Ask the agent to look at it', help: 'A model turn reads what happened; its answer comes to you.' },
  { value: 'run', label: 'Run a command you approved', help: 'One of the commands you let triggers run.' },
];

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'trigger';
}

async function definitionOf(values: ActionValues, ctx: TriggerCommandContext): Promise<Record<string, unknown>> {
  const words = (values.command ?? '').split('\n').filter(Boolean);
  const command = words[0];
  const args = words.slice(1);
  let spec: Record<string, unknown>;
  const interval = (): number => {
    try { return normalizeEverySchedule(values.every || '5m').intervalMs; } catch { throw commandRefusal(`"${values.every}" is not an interval such as 5m or 1h. Nothing was made.`); }
  };
  switch (values.kind) {
    case 'finishes':
      if (!command) throw commandRefusal('Give the command to start. Nothing was made.');
      spec = { kind: 'on-exit', command, ...(args.length > 0 ? { args } : {}) };
      break;
    case 'prints':
      if (!command) throw commandRefusal('Give the command to keep running. Nothing was made.');
      try { new RegExp(values.match ?? ''); } catch { throw commandRefusal(`"${values.match}" is not a pattern a line can match. Nothing was made.`); }
      spec = { kind: 'stream', command, ...(args.length > 0 ? { args } : {}), match: { kind: 'regex', pattern: values.match } };
      break;
    case 'page':
      if (!/^https?:\/\//i.test(values.url ?? '')) throw commandRefusal('A web address starts with https:// (or http://). Nothing was made.');
      spec = { kind: 'condition', probe: { kind: 'http', url: values.url, capture: 'body' }, extract: { kind: 'raw' }, rule: { kind: 'change' }, intervalMs: interval() };
      break;
    default:
      if (!values.path) throw commandRefusal('Give the file to watch. Nothing was made.');
      spec = { kind: 'condition', probe: { kind: 'file', path: values.path, capture: 'stat' }, extract: { kind: 'raw' }, rule: { kind: 'change' }, intervalMs: interval() };
  }
  let action: Record<string, unknown>;
  if (values.then === 'run') {
    const grant = (await listGrants(ctx)).find((entry) => display(entry['id']) === values.grant);
    if (!grant) throw commandRefusal(`No approved command ${values.grant ?? ''}; nothing was made.`, 'Let triggers run it first: /triggers allow-command.');
    action = { kind: 'action-grant', grantId: values.grant, digest: grant['digest'] };
  } else {
    action = { kind: 'agent-turn', ...(values.say ? { prompt: values.say } : {}), ...(values.deliver ? { deliverTo: values.deliver } : {}) };
  }
  return { id: slug(values.name!), label: values.name, spec, action };
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

export const TRIGGERS_COMMAND: CommandDescription<TriggerCommandContext> = {
  name: 'triggers',
  title: 'Triggers',
  summary: 'Act when something happens: a command ends, a line appears, a page or a file changes',
  group: 'Automation',
  report: 'see-triggers',
  firstScreenRows: ['see-triggers', 'watch', 'history', 'stop', 'restart', { label: 'Commands triggers may run', actions: ['see-commands', 'allow-command'] }],
  actions: [
    {
      id: 'see-triggers', label: 'See your triggers', word: 'list', inputs: [],
      sentence: 'Shows who supervises the triggers and each trigger: what it watches, its state and how often it fired.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'watchers.triggers.list', fields: {} }, example: {},
      async run(_values, ctx) {
        // Who supervises them; a daemon that cannot say is described in words, and the list is still read.
        const status = await onDaemon(ctx, false, 'Reading the trigger supervisor', async (invoke) => {
          try {
            return readTriggerOperatorStatus(await invoke('watchers.triggers.status', {})).message;
          } catch (error) {
            let kind: TriggerOperatorFailureKind = 'unavailable';
            if (error instanceof GoodVibesError) {
              const body = error.body;
              const code = body && typeof body === 'object' && 'code' in body ? body.code : error.code;
              for (const candidate of ['other-process', 'future-version'] as const) if (code === `TRIGGER_${candidate.toUpperCase().replaceAll('-', '_')}`) kind = candidate;
            }
            return TRIGGER_OPERATOR_MESSAGES[kind];
          }
        });
        const { triggers, otherProcess } = await listTriggers(ctx);
        ctx.print([
          status,
          triggers.length === 0 ? 'No triggers. Make one: /triggers, "Watch for something".' : `${triggers.length} trigger${triggers.length === 1 ? '' : 's'}${otherProcess ? ' (another process supervises them)' : ''}:`,
          ...triggers.map(triggerLine),
        ].join('\n'));
      },
    },
    {
      id: 'watch', label: 'Watch for something', word: 'watch',
      stepTitles: ['What should it watch?', 'What happens when it does?'],
      inputs: [
        { id: 'name', label: 'Name', help: 'What it is called in your list', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 }, step: 1 },
        {
          id: 'kind', label: 'Watch', help: 'What it watches', kind: 'choice', choices: WATCH_KINDS, step: 1,
          required: { default: 'finishes', defaultMeans: 'a command finishing' },
          typed: { impliedBy: { input: 'match', ifGiven: 'prints', ifNot: 'finishes', orIfGiven: [{ input: 'url', value: 'page' }, { input: 'path', value: 'file' }] } },
        },
        { id: 'command', label: 'Command', help: 'The program and its own arguments, as you would type them', kind: 'list', freeTextReason: 'the program and its arguments', required: true, typed: { tail: true }, step: 1, showWhen: { input: 'kind', is: 'finishes' } },
        { id: 'match', label: 'Lines that match', help: 'A pattern, such as ERROR|FAILED', kind: 'text', freeTextReason: 'a pattern a line matches', required: true, typed: { flag: '--match' }, step: 1, showWhen: { input: 'kind', is: 'prints' } },
        { id: 'url', label: 'Address', help: 'The https:// page to fetch', kind: 'text', freeTextReason: 'the page\'s address', required: true, typed: { flag: '--url' }, step: 1, showWhen: { input: 'kind', is: 'page' } },
        { id: 'path', label: 'File', help: 'The file to look at', kind: 'path', freeTextReason: 'a file on the daemon\'s machine', required: true, typed: { flag: '--file' }, step: 1, showWhen: { input: 'kind', is: 'file' } },
        { id: 'every', label: 'How often', help: 'How often a page or file is looked at, such as 5m or 1h', kind: 'text', freeTextReason: 'an interval such as 5m', required: { default: '5m', defaultMeans: 'every 5 minutes' }, typed: { flag: '--every' }, step: 1 },
        { id: 'then', label: 'Then', help: 'What happens when it fires', kind: 'choice', choices: THEN, required: { default: 'ask', defaultMeans: 'ask the agent to look at it' }, typed: { impliedBy: { input: 'grant', ifGiven: 'run', ifNot: 'ask' } }, step: 2 },
        { id: 'say', label: 'Tell the agent', help: 'Your own instructions for the turn; blank for what happened only', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'what happened, nothing more' }, typed: { flag: '--say' }, step: 2, showWhen: { input: 'then', is: 'ask' } },
        { id: 'deliver', label: 'Answer goes to', help: 'A channel such as telegram or slack:C123', kind: 'text', freeTextReason: 'a channel as configuration writes it', required: { default: '', defaultMeans: 'your owner inbox' }, typed: { flag: '--deliver' }, step: 2, showWhen: { input: 'then', is: 'ask' } },
        { id: 'grant', label: 'Command to run', help: 'Commands you let triggers run', kind: 'choice', choices: { list: GRANTS }, required: true, typed: { flag: '--run' }, step: 2, showWhen: { input: 'then', is: 'run' } },
      ],
      sentence: '{name} will watch what you gave and act each time it fires, until you change it.',
      done: 'Watching: {name}.',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'stop',
      operator: { terminalOnly: 'Watching for something is set up from a terminal app.' },
      example: { name: 'Build finished', command: 'npm\nrun\nbuild' },
      async run(values, ctx) {
        const definition = await definitionOf(values, ctx);
        const trigger = await onDaemon(ctx, true, 'Watching for it', async (invoke) => record(record(await invoke('watchers.triggers.create', { definition }))['trigger']));
        ctx.renderRequest();
        return triggerLine(trigger).trim();
      },
    },
    {
      id: 'history', label: 'See what a trigger did', word: 'history',
      inputs: [TRIGGER, { id: 'count', label: 'How many', help: 'The newest runs to show, 1 to 200', kind: 'number', required: { default: '20', defaultMeans: 'the newest 20' }, typed: { flag: '--count' } }],
      sentence: 'Shows the newest runs of {trigger}: when, the outcome, and how a watched command ended.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'watchers.triggers.history', fields: { id: 'trigger', limit: 'count:number' } },
      example: { trigger: 'build-finished' },
      async run(values, ctx) {
        const count = Number(values.count || '20');
        if (!Number.isInteger(count) || count < 1 || count > 200) throw commandRefusal(`How many is a whole number from 1 to 200; "${values.count}" is not.`);
        const body = await onDaemon(ctx, false, 'Reading its runs', async (invoke) => record(await invoke('watchers.triggers.history', { id: values.trigger, limit: count })));
        const runs = Array.isArray(body['runs']) ? body['runs'].map(record) : [];
        ctx.print([
          triggerLine(record(body['trigger'])).trim(),
          ...(runs.length === 0 ? ['  No runs yet.'] : runs.map((run) => `  ${display(run['at'])} ${display(run['outcome'])}${run['detail'] !== undefined ? `: ${display(run['detail'])}` : ''}`)),
        ].join('\n'));
      },
    },
    {
      id: 'stop', label: 'Stop a trigger', word: 'stop',
      inputs: [TRIGGER],
      sentence: '{trigger} will stop watching, and a command it started is stopped.',
      done: 'Stopped {trigger}.',
      touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'watchers.triggers.cancel', fields: { id: 'trigger' } },
      example: { trigger: 'build-finished' },
      async run(values, ctx) {
        const trigger = await onDaemon(ctx, true, 'Stopping it', async (invoke) => record(record(await invoke('watchers.triggers.cancel', { id: values.trigger }))['trigger']));
        ctx.renderRequest();
        return triggerLine(trigger).trim();
      },
    },
    {
      id: 'restart', label: 'Start a trigger that gave up', word: 'restart',
      inputs: [{ ...TRIGGER, help: 'Triggers that stopped after failing again and again' }],
      sentence: '{trigger}, which stopped after repeated failures, will watch again {lasts}; fix what made it fail first.',
      done: 'Started {trigger} again.',
      touches: 'another-machine', lasts: 'kept', risk: 'none',
      operator: { method: 'watchers.triggers.reset', fields: { id: 'trigger' } },
      example: { trigger: 'build-finished' },
      async run(values, ctx) {
        const trigger = await onDaemon(ctx, true, 'Starting it again', async (invoke) => record(record(await invoke('watchers.triggers.reset', { id: values.trigger }))['trigger']));
        ctx.renderRequest();
        return triggerLine(trigger).trim();
      },
    },
    {
      id: 'see-commands', label: 'See commands triggers may run', word: 'commands', inputs: [],
      sentence: 'Shows each command you let triggers run, with the digest a trigger names.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'watchers.triggers.grant.list', fields: {} }, example: {},
      async run(_values, ctx) {
        const grants = await listGrants(ctx);
        ctx.print(grants.length === 0
          ? 'Triggers may run no command. Let them run one: /triggers, "Let triggers run a command".'
          : [`Triggers may run ${grants.length} command${grants.length === 1 ? '' : 's'}:`, ...grants.map((grant) => `  ${display(grant['id'])}: ${argvOf(grant)} (digest ${display(grant['digest'])}, approved by ${display(grant['confirmedBy'])})`)].join('\n'));
      },
    },
    {
      id: 'allow-command', label: 'Let triggers run a command', word: 'allow-command',
      inputs: [
        { id: 'name', label: 'Name', help: 'What a trigger calls it', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 } },
        { id: 'command', label: 'Command', help: 'The program and its own arguments, run exactly so', kind: 'list', freeTextReason: 'the program and its arguments', required: true, typed: { tail: true } },
      ],
      sentence: 'A trigger may run {command} as {name} when it fires, with nobody asked, until you change it.',
      done: 'Triggers may run {name}.',
      touches: 'another-machine', lasts: 'kept', risk: 'loosens-a-protection',
      ownerOnly: { reason: 'it lets a trigger run a command with nobody asked', instead: 'Ask the owner to choose "Let triggers run a command" in /triggers.' },
      operator: { method: 'watchers.triggers.grant.register', fields: { id: 'name', command: 'command:first', args: 'command:rest', description: 'name' } },
      example: { name: 'deploy', command: 'make\ndeploy' },
      async run(values, ctx) {
        const words = values.command!.split('\n').filter(Boolean);
        const grant = await onDaemon(ctx, true, 'Approving the command', async (invoke) => record(record(await invoke('watchers.triggers.grant.register', {
          id: values.name, command: words[0], args: words.slice(1), description: `Runs ${words.join(' ')}`,
        }))['grant']));
        return `A trigger names it with "Then: Run a command you approved" (digest ${display(grant['digest'])}).`;
      },
    },
  ],
};

const TRIGGERS_SLASH_COMMAND = defineCommand(TRIGGERS_COMMAND);

/** Register `/triggers` (the one description) against the selected daemon this app's policy reaches. */
export function registerRemoteTriggerSupervisorCommand<Context extends TriggerCommandContext>(
  registry: { register(command: TerminalSlashCommand<Context>): void },
  policy: PaymentWindowCommandPolicy<Context>,
): void {
  installedPolicy = policy as unknown as PaymentWindowCommandPolicy<TriggerCommandContext>;
  registry.register(TRIGGERS_SLASH_COMMAND as unknown as TerminalSlashCommand<Context>);
}
