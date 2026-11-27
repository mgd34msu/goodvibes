import { RefusalError, readRefusal, refusal, type TargetChange } from '@goodvibes/engine/errors';
import { isPathWithinRoot } from '@goodvibes/engine/platform/platform/runtime/shell-paths';

/**
 * What a slash command throws when it did not do what was asked: an unknown id,
 * a missing argument, a refusal, a failed step. The terminal prints it as
 * "reason. next"; the model's command runner reports it as a failed call with
 * the same reason and next step. A handler that returns did what it says.
 */
export function commandRefusal(text: string, next?: string, code?: string, cause?: unknown): RefusalError {
  const trimmed = text.trim();
  const usage = /^Usage:/i.test(trimmed);
  return new RefusalError(refusal({
    code: code ?? (usage ? 'USAGE' : 'COMMAND_REFUSED'),
    state: 'not done',
    reason: trimmed.replace(/^(Refused|Error):\s*/i, ''),
    next: next ? [next] : [],
    // The failure it was made from, kept so a caller can decide by its kind (settings-writes.ts: no daemon answered).
  }), cause !== undefined ? { cause } : {});
}

/**
 * A file a model-run command writes stays inside the working directory, where
 * the model's own file tools may write; the owner may name any path. Links are
 * followed, so a link inside that points outside is outside.
 */
export function refuseModelWriteOutsideWorkingDirectory(ctx: { readonly invokedByModel?: boolean | undefined }, workingDirectory: string, target: string): void {
  if (ctx.invokedByModel !== true || isPathWithinRoot(workingDirectory, target)) return;
  throw commandRefusal(`${target} is outside the working directory; nothing was written.`, 'Name a path inside the working directory, or ask the owner to run the command.');
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
  let text = false;
  for (const token of args) {
    // Words after `--` are text: a --yes there is a word of it.
    if (token === '--') text = true;
    if (token === '--yes' && !text) {
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
    if (index >= skip && (!token.startsWith('--') || token === '--')) break;
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
export interface CommandConfirmation<R = unknown> {
  /** The act, as a question title: "Delete principal p_123?". */
  readonly title: string;
  /** What will change and what cannot be recovered afterwards. */
  readonly detail: string;
  /** The confirming button: "Delete", "Revoke", "Send". */
  readonly confirmLabel: string;
  /**
   * What the person is being shown (a `TargetRef` from platform/utils/target-ref.ts,
   * or the exact plan), handed to the handler unchanged so it acts on that and
   * not on a second reading. A handler that finds its target changed throws
   * `TargetChangedError` (code `TARGET_CHANGED`) and the owner is asked again.
   */
  readonly reviewed?: R | undefined;
}

/** A command that may declare the one confirmation its irreversible lines need. */
export interface ConfirmableCommand<Context, R = unknown> {
  readonly name: string;
  /** `reviewed` is the confirmation's `reviewed` value when the line was confirmed; undefined for a line that asks nothing. */
  readonly handler: (args: string[], context: Context, reviewed?: R) => void | Promise<void>;
  /**
   * Called with the line's arguments (without `--yes`). Returns the question
   * for a line that cannot be undone or changes access; undefined for a line
   * that is reversible, a read, or incomplete (the handler prints its usage).
   */
  readonly confirm?: ((args: readonly string[], context: Context) => CommandConfirmation<R> | undefined) | undefined;
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
  readonly confirm?: ((options: { readonly title: string; readonly body: string; readonly confirmLabel: string; readonly cancelLabel?: string; readonly tone?: 'danger' | 'warning' | 'primary' }) => Promise<boolean>) | undefined;
}

/**
 * The words with the first one lower-cased when it is a word (letters, digits
 * and dashes, starting with a letter): the action word of a command that
 * declares a confirmation. Anything else (a path, an id, a flag) is left as typed.
 */
export function foldFirstWord(args: readonly string[]): string[] {
  const first = args[0];
  if (first === undefined || !/^[A-Za-z][A-Za-z0-9-]*$/.test(first) || first === first.toLowerCase()) return [...args];
  return [first.toLowerCase(), ...args.slice(1)];
}

/** The changes a `TARGET_CHANGED` refusal carries, or undefined when `error` is not one. */
function targetChangesOf(error: unknown): readonly TargetChange[] | undefined {
  const carried = readRefusal(error);
  return carried?.code === 'TARGET_CHANGED' ? carried.changes ?? [] : undefined;
}

/** The lines put above a question asked again: each change since the person looked. */
export function describeTargetChanges(changes: readonly TargetChange[]): string {
  const lines = changes.map((change) => change.now === null
    ? `- ${change.field}: ${change.was} is gone`
    : `- ${change.field}: was ${change.was}, now ${change.now}`);
  return ['Changed since you looked:', ...(lines.length > 0 ? lines : ['- the target is not what was shown'])].join('\n');
}

/**
 * The one confirmation rule for typed commands, applied by the command registry
 * at registration so no handler decides it. As released, in every permission mode
 * a line the command marks as irreversible asks once inline; `--yes` typed by the
 * owner is the answer given in advance (for scripts and surfaces with no dialog);
 * `--yes` from a model is ignored, so a model-run line is put to the owner, in
 * every mode.
 *
 * The handler receives the question's `reviewed` value, what was shown. When
 * it refuses with `TARGET_CHANGED` (the target moved between the question and
 * the act), an owner's line on a surface with a dialog is asked once more,
 * with the changes above the new question, and runs on the new `reviewed`; a
 * model-run line, or a surface with no dialog, gets the refusal with the same
 * line as its next step.
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
    async handler(typed: string[], context: Context): Promise<void> {
      // The first word is read case-folded once, here, so the question and the
      // handler act on the same word: `/hooks Remove x` asks exactly as
      // `/hooks remove x` does, and never runs unasked.
      const args = foldFirstWord(typed);
      const { rest, yes } = command.leadingFlagsOnly === true ? stripLeadingYesFlag(args) : stripYesFlag(args);
      const question = confirm(rest, context);
      if (!question) {
        await handler(args, context);
        return;
      }
      const run = async (reviewed: unknown): Promise<void> => {
        try {
          await handler([...rest], context, reviewed);
        } catch (error) {
          const changes = targetChangesOf(error);
          if (changes === undefined) throw error;
          const line = `/${command.name}${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
          if (context.invokedByModel === true || !context.confirm) {
            const carried = readRefusal(error)!;
            throw new RefusalError(refusal({ ...carried, next: [line, ...carried.next.filter((step) => step !== line)] }));
          }
          const again = confirm(rest, context);
          if (!again) throw error;
          const answered = await context.confirm({
            title: again.title,
            body: `${describeTargetChanges(changes)}\n\n${again.detail}`,
            confirmLabel: again.confirmLabel,
            tone: 'danger',
          });
          if (!answered) throw commandRefusal(`/${command.name}: cancelled; nothing was changed.`, undefined, 'CANCELLED');
          // Asked once more only: a second change is the refusal itself.
          await handler([...rest], context, again.reviewed);
        }
      };
      if (yes && context.invokedByModel !== true) {
        await run(question.reviewed);
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
      await run(question.reviewed);
    },
  };
}

/** What the shared confirmations below read from the surface's command context. */
export interface SharedConfirmationContext {
  readonly platform: { readonly configManager: { getCategory(category: 'notifications'): { readonly webhookUrls?: unknown } } };
  /** The line came from the model's command runner, not the owner's keyboard. */
  readonly invokedByModel?: boolean | undefined;
}

type SharedConfirm = (args: readonly string[], context: SharedConfirmationContext) => CommandConfirmation | undefined;

/**
 * The irreversible lines of the commands both terminal apps build from shared
 * shell code, by command name. (Described commands ask from their
 * descriptions, command-actions/.) Each app's registry applies them through
 * {@link withOwnerConfirmation}, so the two apps answer the same line the same
 * way; reversible lines are not listed and run at once. (`/secrets` declares
 * its own.) None is left: removing every webhook address is the daemon's
 * capability `notify.clear`, which asks from its own words (cannot be undone).
 */
export const SHARED_COMMAND_CONFIRMATIONS: Readonly<Partial<Record<string, SharedConfirm>>> = {};
