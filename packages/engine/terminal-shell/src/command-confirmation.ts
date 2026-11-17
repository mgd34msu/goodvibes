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
    // Applied once: a command wrapped here and registered through a registry
    // that wraps every registration is not asked twice.
    confirm: undefined,
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

/** What the shared confirmations below read from the surface's command context. */
export interface SharedConfirmationContext {
  readonly platform: { readonly configManager: { getCategory(category: 'notifications'): { readonly webhookUrls?: unknown } } };
}

type SharedConfirm = (args: readonly string[], context: SharedConfirmationContext) => CommandConfirmation | undefined;

/**
 * The irreversible lines of the commands both terminal apps build from shared
 * shell code (`/notify`, `/mcp`, `/provider`), by command name. Each app's
 * registry applies them through {@link withOwnerConfirmation}, so the two apps
 * answer the same line the same way; reversible lines are not listed and run
 * at once. (`/secrets` declares its own.)
 */
export const SHARED_COMMAND_CONFIRMATIONS: Readonly<Partial<Record<string, SharedConfirm>>> = {
  notify(args, context) {
    if (args[0] !== 'clear') return undefined;
    const urls = context.platform.configManager.getCategory('notifications').webhookUrls;
    const count = Array.isArray(urls) ? urls.length : 0;
    if (count === 0) return undefined;
    return {
      title: `Remove all ${count} webhook URL${count === 1 ? '' : 's'}?`,
      detail: 'Every webhook notification URL is removed. They are shown masked, so note any you need before clearing; /notify add <url> adds one back.',
      confirmLabel: 'Clear',
    };
  },
  mcp(args) {
    if (args[0] !== 'remove' || !args[1]) return undefined;
    return {
      title: `Remove MCP server ${args[1]}?`,
      detail: `${args[1]}'s entry (its command, arguments, environment and trust settings) is deleted from the MCP config and its tools stop being offered. Re-adding it means typing the whole /mcp add line again.`,
      confirmLabel: 'Remove',
    };
  },
  provider(args) {
    if ((args[0] !== 'remove' && args[0] !== 'rm') || !args[1]) return undefined;
    return {
      title: `Remove custom provider ${args[1]}?`,
      detail: `The provider file for ${args[1]} (its base URL and model list) is deleted and its models leave the picker. /provider add creates it again.`,
      confirmLabel: 'Remove',
    };
  },
};
