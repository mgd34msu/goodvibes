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

export function requireYesFlag(ctx: CommandConfirmationContext, action: string, usage: string): boolean {
  ctx.print(`Refusing to ${action} without --yes.\nUsage: ${usage}`);
  return false;
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
      const { rest, yes } = stripYesFlag(args);
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
        context.print(`${question.title.replace(/\?$/, '')}: not done. ${question.detail}\nThis surface cannot ask; type the same line with --yes to confirm it.`);
        return;
      }
      const answered = await context.confirm({ title: question.title, body: question.detail, confirmLabel: question.confirmLabel, tone: 'danger' });
      if (!answered) {
        context.print(`/${command.name}: cancelled; nothing was changed.`);
        return;
      }
      await handler([...rest], context);
    },
  };
}
