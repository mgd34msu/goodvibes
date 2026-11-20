/**
 * `defineCommand` turns one description into the command both terminal apps
 * register. Every field a command used to write by hand is generated here, and
 * so is the handler:
 *
 * - a complete line runs the action (the registry has already asked, when the
 *   action carries a risk);
 * - a line with a blank missing opens the guided path at that blank where a
 *   dialog can be shown, and is refused naming the blank and its current
 *   choices where none can (a model, a script);
 * - a bare command opens the action list where a dialog can be shown, and runs
 *   the report action where none can.
 */
import { commandRefusal, type ConfirmableCommand } from '../command-confirmation.js';
import type { CommandSecretArgs, TerminalCommandEffect, TerminalSlashCommand } from '../command-registry.js';
import {
  GENERATED_COMMAND_FIELDS,
  generatedArgsHint,
  generatedConfirm,
  generatedEffect,
  generatedSecretArgs,
  generatedSubcommandHints,
  generatedUsage,
  ownerOnlyActionRefusal,
  ownerOnlyFor,
} from './generated-fields.js';
import { runGuided } from './guided.js';
import { isCommandReport, renderCommandReport } from './report.js';
import { listByName } from './lists.js';
import { actionDoneLine, fixedChoices, linePattern, parseTypedLine } from './typed-line.js';
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription, InputDescription } from './types.js';

/** What `defineCommand` returns: an ordinary registered command that carries its description. */
export type DescribedCommand<Ctx> = TerminalSlashCommand<Ctx> & ConfirmableCommand<Ctx> & {
  readonly subcommands: Readonly<Record<string, string>>;
  readonly described: CommandDescription<Ctx>;
};

interface GeneratedFields {
  readonly description: string;
  readonly usage: string;
  readonly argsHint: string;
  readonly subcommands: Readonly<Record<string, string>>;
  readonly effect: TerminalCommandEffect;
  readonly readVerbs: readonly string[];
  readonly secretArgs: CommandSecretArgs;
  readonly strictArgs: boolean;
  readonly confirm: ReturnType<typeof generatedConfirm>;
  readonly aliases: string[];
}

const generatedFor = new WeakMap<CommandDescription<never>, GeneratedFields>();
const describedByName = new Map<string, CommandDescription<never>>();

/** The description a command was built from, by command name (the Agent workspace's rows open its actions). */
export function describedCommandByName(name: string): CommandDescription<never> | undefined {
  return describedByName.get(name);
}

/** Choices shown in a refusal for a missing blank. */
const REFUSAL_CHOICES = 20;

async function choicesForRefusal(input: InputDescription, values: ActionValues, ctx: CommandActionContext): Promise<string> {
  const fixed = fixedChoices(input);
  if (fixed) return ` Choices: ${fixed.map((choice) => `${choice.value} (${choice.label})`).join(', ')}.`;
  if (!input.choices || !('list' in input.choices)) return input.freeTextReason ? ` It is typed: ${input.freeTextReason}.` : '';
  try {
    const rows = await listByName<CommandActionContext>(input.choices.list).read(ctx, values, new AbortController().signal);
    if (rows.length === 0) return ' There is nothing to choose from right now.';
    const shown = rows.slice(0, REFUSAL_CHOICES).map((row) => row.value);
    return ` Current choices: ${shown.join(', ')}${rows.length > shown.length ? ` and ${rows.length - shown.length} more` : ''}.`;
  } catch {
    return '';
  }
}

async function runComplete<Ctx extends CommandActionContext>(description: CommandDescription<Ctx>, action: ActionDescription<Ctx>, values: ActionValues, ctx: Ctx): Promise<void> {
  const owner = ownerOnlyFor(action as ActionDescription<never>, values);
  if (owner && ctx.invokedByModel === true) throw ownerOnlyActionRefusal(description.name, action as ActionDescription<never>, owner.reason, owner.instead);
  const detail = await action.run(values, ctx);
  const done = actionDoneLine(action as ActionDescription<never>, values);
  const lines = [...(done ? [done] : []), ...(isCommandReport(detail) ? [renderCommandReport(detail)] : typeof detail === 'string' && detail ? [detail] : [])];
  if (lines.length > 0) ctx.print(lines.join('\n'));
}

export function defineCommand<Ctx extends CommandActionContext>(description: CommandDescription<Ctx>): DescribedCommand<Ctx> {
  const unknown = description as unknown as CommandDescription<never>;
  const { effect, readVerbs } = generatedEffect(unknown);
  const held = generatedFor.get(unknown);
  const fields: GeneratedFields = held ?? {
    description: description.summary,
    usage: generatedUsage(unknown),
    argsHint: generatedArgsHint(unknown),
    subcommands: generatedSubcommandHints(unknown),
    effect,
    readVerbs,
    secretArgs: generatedSecretArgs(unknown),
    strictArgs: true,
    confirm: generatedConfirm(unknown),
    aliases: [],
  };
  generatedFor.set(unknown, fields);
  describedByName.set(description.name, unknown);
  return {
    name: description.name,
    ...fields,
    ...(description.firstScreen === false ? { firstScreen: false } : {}),
    described: description,
    async handler(args: string[], ctx: Ctx): Promise<void> {
      const parsed = parseTypedLine(description, args);
      const dialog = ctx.invokedByModel !== true && ctx.openSelection !== undefined;
      const names = description.actions.map((action) => `${action.word} (${action.label})`).join(', ');
      if ('bare' in parsed) {
        if (dialog) { await runGuided(unknown, {}, ctx); return; }
        const report = description.actions.find((action) => action.id === description.report);
        if (!report) throw commandRefusal(`/${description.name} needs an action. The actions are: ${names}.`, `/help ${description.name} shows each one with its line.`, 'USAGE');
        await runComplete(description, report, defaultsOf(report as ActionDescription<never>), ctx);
        return;
      }
      if ('unknownWord' in parsed) {
        throw commandRefusal(`/${description.name} has no action "${parsed.unknownWord}". The actions are: ${names}.`, `/help ${description.name} shows each one with its line.`, 'USAGE');
      }
      const action = description.actions.find((candidate) => candidate.id === parsed.action.id)!;
      if (parsed.problem) throw commandRefusal(parsed.problem, `Usage: /${description.name} ${linePattern(parsed.action)}`, 'USAGE');
      if (parsed.missing.length > 0) {
        if (dialog) {
          const given = Object.fromEntries(parsed.given.map((id) => [id, parsed.values[id]!]));
          await runGuided(unknown, { action: parsed.action, values: given }, ctx);
          return;
        }
        const blank = parsed.missing[0]!;
        const choices = await choicesForRefusal(blank, parsed.values, ctx);
        throw commandRefusal(
          `/${description.name} ${action.word} (${action.label}) needs ${blank.label}: ${blank.help}.${choices}`,
          `Usage: /${description.name} ${linePattern(parsed.action)}`,
          'USAGE',
        );
      }
      await runComplete(description, action, parsed.values, ctx);
    },
  };
}

function defaultsOf(action: ActionDescription<never>): ActionValues {
  return Object.fromEntries(action.inputs.flatMap((input) => input.required === true ? [] : [[input.id, input.required.default]]));
}

/**
 * Refuses a described command whose generated fields were overwritten by hand
 * (`{ ...defineCommand(d), usage: '...' }`): the description is the only place
 * they come from. Called by each app's registry before it registers.
 */
export function assertDescribedCommand(registered: { readonly name: string; readonly described?: unknown }): void {
  const command = registered as unknown as Readonly<Record<string, unknown>> & { readonly name: string };
  const description = registered.described as CommandDescription<never> | undefined;
  if (!description) return;
  const fields = generatedFor.get(description);
  if (!fields) throw new Error(`/${command.name} carries a description that was not built with defineCommand.`);
  for (const field of GENERATED_COMMAND_FIELDS) {
    if (field === 'hidden') {
      if (command.hidden !== undefined) throw new Error(`/${command.name} is described; it says "firstScreen: false" in its description instead of hidden.`);
      continue;
    }
    if (command[field] !== (fields as unknown as Readonly<Record<string, unknown>>)[field]) {
      throw new Error(`/${command.name} is described, so its ${field} is generated from the description; it may not be written by hand.`);
    }
  }
  if (command.name !== description.name) throw new Error(`/${command.name} is registered under another name than its description's (${description.name}).`);
}
