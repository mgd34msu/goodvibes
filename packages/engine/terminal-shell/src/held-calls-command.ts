/**
 * /held: the calls permissions.mode just-vibes held for the owner instead of
 * interrupting him. The end of each run lists them; here he approves or sets
 * them aside. An approval is his "allow for this session" answer for that
 * exact call, so it runs when the work is carried on. A command the model runs
 * may list them but never approves one: the answer is the owner's.
 */
import { processHeldForOwner, type HeldForOwnerLedger } from '@goodvibes/engine/platform/platform/permissions';
import type { TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext } from './command-actions/types.js';
import { readAction } from './described-command-kit.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';

export interface HeldCallsCommandContext extends CommandActionContext {
  readonly renderRequest: () => void;
}

export interface HeldCallsCommandPolicy<Context> {
  /** True only when the owner typed `command` at this terminal. */
  readonly isOwner: (context: Context, command: string) => boolean;
  /** The held calls this terminal answers; the process's by default. */
  readonly ledger?: (() => HeldForOwnerLedger) | undefined;
}

function text(value: string): string {
  return stripDangerousAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
}

const HELD_CALLS = defineList<unknown>({
  name: 'held-calls',
  async read() {
    return processHeldForOwner().list().map((call): ListRow => ({ value: call.id, label: `${text(call.toolName)}: ${text(call.summary)}`, detail: text(call.reason) }));
  },
  operator: { terminalOnly: 'Held calls belong to the terminal session that held them.' },
});

/** Register `/held` (one description for both apps). */
export function registerHeldCallsCommand<Context extends HeldCallsCommandContext>(
  registry: Pick<TerminalCommandRegistry<Context>, 'register'>,
  policy: HeldCallsCommandPolicy<Context>,
): void {
  const ledger = policy.ledger ?? processHeldForOwner;
  const answer = (verb: 'approve' | 'dismiss'): ActionDescription<Context>['run'] => async (values, context) => {
    // The answer is the owner's: a model running this command never approves or sets aside for him.
    if (!policy.isOwner(context, 'held')) throw commandRefusal(`Only you can ${verb === 'approve' ? 'approve' : 'set aside'} a held call: type /held ${verb} yourself. Nothing was changed.`);
    const wanted = (values.calls ?? '').split(/\s+/).map((arg) => arg.trim()).filter(Boolean);
    const ids = wanted.some((id) => id.toLowerCase() === 'all') ? 'all' as const : wanted;
    const done = verb === 'approve' ? ledger().approve(ids) : ledger().dismiss(ids);
    const missing = ids === 'all' ? [] : ids.filter((id) => !done.includes(id));
    context.renderRequest();
    if (done.length === 0) throw commandRefusal(`No held call ${ids === 'all' ? 'is waiting' : `has the id ${missing.map(text).join(', ')}`}. Nothing was changed.`, '/held lists them.');
    return [
      verb === 'approve'
        ? `Approved ${done.join(', ')} for this session: ask me to carry on and ${done.length === 1 ? 'it runs' : 'they run'} when made again.`
        : `Set aside ${done.join(', ')}; ${done.length === 1 ? 'it was' : 'they were'} not run.`,
      ...(missing.length > 0 ? [`Not held (already answered or unknown): ${missing.map(text).join(', ')}.`] : []),
    ].join('\n');
  };
  const CALLS = {
    id: 'calls', label: 'Held calls', help: 'The calls held for you; several ids separated by spaces, or all', kind: 'choice' as const,
    choices: { list: HELD_CALLS, allowOther: { reason: 'several ids separated by spaces, or all' } }, required: true as const, typed: { tail: true } as const,
  };
  registry.register(defineCommand<Context>({
    name: 'held',
    title: 'Held calls',
    summary: 'Calls just-vibes held for you instead of asking: approve them or set them aside',
    group: 'Permissions',
    report: 'list',
    actions: [
      readAction<Context>({
        id: 'list', label: 'See the calls held for you', word: 'list',
        sentence: 'Lists the calls just-vibes held instead of asking you, with why each was held.',
        async run(_values, context) {
          const held = ledger().list();
          if (held.length === 0) return 'Nothing is held for you.';
          return [
            `Held for you (${String(held.length)}, not run):`,
            ...held.map((call) => `  ${call.id}  ${text(call.toolName)}: ${text(call.summary)} (${text(call.reason)})`),
            'Approve with /held approve <id> (or all), then ask to carry on; /held dismiss <id> sets one aside.',
          ].join('\n');
        },
      }),
      {
        id: 'approve', label: 'Approve a held call', word: 'approve', inputs: [CALLS],
        sentence: '{calls} may run for this session only, when the work carries on.', done: '',
        touches: 'this-machine', lasts: 'session', risk: 'loosens-a-protection',
        ownerOnly: { reason: 'the answer to a held call is the owner\'s', instead: 'Ask the owner to approve it with /held approve.' },
        operator: { terminalOnly: 'Held calls belong to the terminal session that held them.' }, example: { calls: 'h-1' },
        run: answer('approve'),
      },
      {
        id: 'dismiss', label: 'Set a held call aside', word: 'dismiss', inputs: [CALLS],
        sentence: '{calls} is set aside and not run, for this session only; the model may make the call again.', done: '',
        touches: 'this-machine', lasts: 'session', risk: 'none',
        ownerOnly: { reason: 'the answer to a held call is the owner\'s', instead: 'Ask the owner to set it aside with /held dismiss.' },
        operator: { terminalOnly: 'Held calls belong to the terminal session that held them.' }, example: { calls: 'h-1' },
        run: answer('dismiss'),
      },
    ],
  }));
}
