import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';

/**
 * What a slash command throws when it did not do what was asked: an unknown id,
 * a missing argument, a refusal, a failed step. The terminal prints it as
 * "reason. next"; the model's command runner reports it as a failed call with
 * the same reason and next step. A handler that returns did what it says.
 */
export function commandRefusal(text: string, next?: string, code?: string): RefusalError {
  const trimmed = text.trim();
  const usage = /^Usage:/i.test(trimmed);
  return new RefusalError(refusal({
    code: code ?? (usage ? 'USAGE' : 'COMMAND_REFUSED'),
    state: 'not done',
    reason: trimmed.replace(/^(Refused|Error):\s*/i, ''),
    next: next ? [next] : [],
  }));
}

export interface CommandConfirmationContext {
  readonly print: (message: string) => void;
}

export interface ConfirmationArgs {
  readonly rest: readonly string[];
  readonly yes: boolean;
}

export function stripYesFlag(args: readonly string[]): ConfirmationArgs {
  const rest: string[] = [];
  let yes = false;
  for (const token of args) {
    if (token === '--yes') {
      yes = true;
      continue;
    }
    rest.push(token);
  }
  return { rest, yes };
}

/**
 * `--yes` for a line whose tail is free text (a mail body, an event title):
 * read only among the `--` words before the first field, so the same word in
 * the text is text and is sent as typed. The first `skip` words (the
 * subcommand) are passed over; the first later word that is not a flag ends
 * the flags.
 */
export function stripLeadingYesFlag(args: readonly string[], skip = 1): ConfirmationArgs {
  const rest: string[] = [];
  let yes = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const token = args[index]!;
    if (index >= skip && !token.startsWith('--')) break;
    if (token === '--yes') {
      yes = true;
      continue;
    }
    rest.push(token);
  }
  for (; index < args.length; index += 1) rest.push(args[index]!);
  return { rest, yes };
}

/**
 * `--yes` on a free-text tail the command takes as typed (`rawRest`): a first
 * or last word `--yes` confirms and is not part of the text; any other
 * occurrence is text.
 */
export function takeYesFromText(text: string): { readonly text: string; readonly yes: boolean } {
  let rest = text.trim();
  let yes = false;
  if (/^--yes(?:\s|$)/.test(rest)) { yes = true; rest = rest.slice('--yes'.length).trimStart(); }
  if (/(?:^|\s)--yes$/.test(rest)) { yes = true; rest = rest.slice(0, -'--yes'.length).trimEnd(); }
  return { text: rest, yes };
}

/** Refuses a line that needs `--yes`: nothing was done, and the usage says how to confirm it. */
export function requireYesFlag(_ctx: CommandConfirmationContext, action: string, usage: string): never {
  throw commandRefusal(`Refusing to ${action} without --yes.`, `Usage: ${usage}`, 'CONFIRMATION_REQUIRED');
}

/**
 * What a command line that cannot be undone, or that changes who has access,
 * asks once before it runs. A reversible line declares nothing and runs at once.
 */
export interface CommandConfirmation {
  /** The act, as a question title: "Delete principal p_123?". */
  readonly title: string;
  /** What will change and what cannot be recovered afterwards. */
  readonly detail: string;
  /** The confirming button: "Delete", "Revoke", "Send". */
  readonly confirmLabel: string;
}

/** A command that may declare the one confirmation its irreversible lines need. */
export interface ConfirmableCommand<Context> {
  readonly name: string;
  readonly handler: (args: string[], context: Context) => void | Promise<void>;
  /**
   * Called with the line's arguments (without `--yes`). Returns the question
   * for a line that cannot be undone or changes access; undefined for a line
   * that is reversible, a read, or incomplete (the handler prints its usage).
   */
  readonly confirm?: ((args: readonly string[], context: Context) => CommandConfirmation | undefined) | undefined;
  /**
   * The line's tail is free text: `--yes` counts only right after the
   * subcommand, before the first field (stripLeadingYesFlag), never inside the text.
   */
  readonly leadingFlagsOnly?: boolean | undefined;
}

/** The surface a confirmation is asked on. */
export interface ConfirmationHost {
  readonly print: (message: string) => void;
  readonly invokedByModel?: boolean | undefined;
  /** A yes/no dialog; resolves true only when the confirming choice is made. */
  readonly confirm?: ((options: { readonly title: string; readonly body: string; readonly confirmLabel: string; readonly tone?: 'danger' | 'warning' | 'primary' }) => Promise<boolean>) | undefined;
}

/**
 * The one confirmation rule for typed commands, applied by the command registry
 * at registration so no handler decides it: a line the command marks as
 * irreversible asks once inline; `--yes` typed by the owner is the answer given
 * in advance (for scripts and surfaces with no dialog); `--yes` from a model is
 * ignored, so a model-run line is always put to the owner.
 */
export function withOwnerConfirmation<Context extends ConfirmationHost, Command extends ConfirmableCommand<Context>>(command: Command): Command {
  const confirm = command.confirm;
  if (!confirm) return command;
  const handler = command.handler;
  return {
    ...command,
    async handler(args: string[], context: Context): Promise<void> {
      const { rest, yes } = command.leadingFlagsOnly === true ? stripLeadingYesFlag(args) : stripYesFlag(args);
      const question = confirm(rest, context);
      if (!question) {
        await handler(args, context);
        return;
      }
      if (yes && context.invokedByModel !== true) {
        await handler([...rest], context);
        return;
      }
      if (!context.confirm) {
        const where = command.leadingFlagsOnly === true ? ` right after /${command.name}${rest[0] ? ` ${rest[0]}` : ''}` : '';
        throw commandRefusal(`${question.title.replace(/\?$/, '')}: not done. ${question.detail}`,
          context.invokedByModel === true ? `Ask the owner to type the same line with --yes${where}.` : `This surface cannot ask; type the same line with --yes${where} to confirm it.`,
          'CONFIRMATION_REQUIRED');
      }
      const answered = await context.confirm({ title: question.title, body: question.detail, confirmLabel: question.confirmLabel, tone: 'danger' });
      if (!answered) throw commandRefusal(`/${command.name}: cancelled; nothing was changed.`, undefined, 'CANCELLED');
      await handler([...rest], context);
    },
  };
}
