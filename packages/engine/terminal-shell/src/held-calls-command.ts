/**
 * /held: the calls permissions.mode just-vibes held for the owner instead of
 * interrupting him. The end of each run lists them; here he approves or sets
 * them aside. An approval is his "allow for this session" answer for that
 * exact call, so it runs when the work is carried on. A command the model runs
 * may list them but never approves one: the answer is the owner's.
 */
import { processHeldForOwner, type HeldForOwnerLedger } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { TerminalSlashCommand } from './command-registry.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';

export interface HeldCallsCommandContext {
  readonly print: (text: string) => void;
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

export function createHeldCallsCommand<Context extends HeldCallsCommandContext>(
  policy: HeldCallsCommandPolicy<Context>,
): TerminalSlashCommand<Context> {
  const ledger = policy.ledger ?? processHeldForOwner;
  const say = (context: Context, message: string) => {
    context.print(message);
    context.renderRequest();
  };
  return {
    name: 'held',
    description: 'Calls just-vibes held for you instead of asking: list, approve or set aside',
    usage: '[list] | approve <id...|all> | dismiss <id...|all>',
    argsHint: '[list|approve|dismiss]',
    effect: 'mixed',
    readVerbs: ['list'],
    handler(args, context) {
      // Read before anything else: a model running this command must not approve for the owner.
      const owner = policy.isOwner(context, 'held');
      const sub = (args[0] ?? 'list').toLowerCase();
      if (sub === 'list' || sub === '') {
        const held = ledger().list();
        if (held.length === 0) {
          say(context, '[held] Nothing is held for you.');
          return;
        }
        say(context, [
          `Held for you (${String(held.length)}, not run):`,
          ...held.map((call) => `  ${call.id}  ${text(call.toolName)}: ${text(call.summary)} (${text(call.reason)})`),
          'Approve with /held approve <id> (or all), then ask to carry on; /held dismiss <id> sets one aside.',
        ].join('\n'));
        return;
      }
      if (sub !== 'approve' && sub !== 'dismiss') {
        say(context, `[held] Unknown subcommand "${text(sub)}". Usage: /held [list] | approve <id...|all> | dismiss <id...|all>`);
        return;
      }
      if (!owner) {
        say(context, `[held] Only you can ${sub} a held call: type /held ${sub} yourself. Nothing was changed.`);
        return;
      }
      const wanted = args.slice(1).map((arg) => arg.trim()).filter(Boolean);
      if (wanted.length === 0) {
        say(context, `[held] Name the calls to ${sub} (ids from /held), or all. Nothing was changed.`);
        return;
      }
      const ids = wanted.some((id) => id.toLowerCase() === 'all') ? 'all' as const : wanted;
      const done = sub === 'approve' ? ledger().approve(ids) : ledger().dismiss(ids);
      const missing = ids === 'all' ? [] : ids.filter((id) => !done.includes(id));
      if (done.length === 0) {
        say(context, `[held] No held call ${ids === 'all' ? 'is waiting' : `has the id ${missing.map(text).join(', ')}`}; /held lists them. Nothing was changed.`);
        return;
      }
      say(context, [
        sub === 'approve'
          ? `[held] Approved ${done.join(', ')} for this session: ask me to carry on and ${done.length === 1 ? 'it runs' : 'they run'} when made again.`
          : `[held] Set aside ${done.join(', ')}; ${done.length === 1 ? 'it was' : 'they were'} not run.`,
        ...(missing.length > 0 ? [`[held] Not held (already answered or unknown): ${missing.map(text).join(', ')}.`] : []),
      ].join('\n'));
    },
  };
}
