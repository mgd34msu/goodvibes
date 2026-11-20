/**
 * Completion past the first word of a described command: the action words with
 * their labels, then the values of the blank being typed (its fixed choices or
 * its live list, read only once the dropdown asks), then option names with
 * their labels when a `--` word is started.
 */
import { tokenizeSlashCommand } from '../slash-command-parser.js';
import type { ListRow } from './lists.js';
import { fillSentence, fixedChoices, singleAction, switchValue } from './typed-line.js';
import type { CommandDescription, InputDescription, ListName } from './types.js';

export interface ArgumentCompletionItem {
  /** What Tab puts in place of the word being typed. */
  readonly value: string;
  readonly label: string;
  readonly detail?: string | undefined;
}

export interface ArgumentCompletion {
  /** What the dropdown is listing: "Actions", "Server", "Options". */
  readonly header: string;
  readonly items: readonly ArgumentCompletionItem[];
  /** The word being typed, which Tab replaces. */
  readonly partial: string;
  /** The live list is being read; the rows arrive with a later update. */
  readonly pending?: boolean | undefined;
}

/** Reads a live list's rows for completion, or undefined while they are being read. */
export type CompletionListReader = (list: ListName, earlier: Readonly<Record<string, string>>) => readonly ListRow[] | undefined;

function matches(partial: string, ...texts: readonly (string | undefined)[]): boolean {
  if (!partial) return true;
  const lower = partial.toLowerCase();
  return texts.some((text) => text?.toLowerCase().startsWith(lower));
}

/**
 * The completion for the words typed after `/name `: `afterName` is the rest of
 * the composer line. Undefined when there is nothing to offer.
 */
export function completeArguments<Ctx>(
  description: CommandDescription<Ctx>,
  afterName: string,
  readRows: CompletionListReader,
): ArgumentCompletion | undefined {
  const endsWithSpace = /\s$/.test(afterName);
  const words = [...tokenizeSlashCommand(`/x ${afterName}`)].slice(1);
  const partial = endsWithSpace ? '' : (words.pop() ?? '');
  // A single-action command has no action word: its words are the action's blanks from the first.
  if (singleAction(description)) words.unshift('');
  if (words.length === 0) {
    const items = description.actions
      .filter((action) => matches(partial, action.word, action.label))
      .map((action) => ({ value: action.word, label: `${action.word}  ${action.label}`, detail: fillSentence(action.sentence, Object.fromEntries(action.inputs.map((input) => [input.id, `<${input.label.toLowerCase()}>`])), '') }));
    return items.length > 0 ? { header: 'Actions', items, partial } : undefined;
  }
  const action = description.actions.find((candidate) => candidate.word === words[0]!.toLowerCase());
  if (!action) return undefined;
  if (partial.startsWith('-')) {
    const items = action.inputs
      .filter((input): input is InputDescription & { typed: { flag: `--${string}` } } => 'flag' in input.typed)
      .filter((input) => matches(partial, input.typed.flag))
      .map((input) => ({ value: input.typed.flag, label: `${input.typed.flag}  ${switchValue(input) ? fixedChoices(input)?.find((choice) => choice.value === switchValue(input)?.on)?.label ?? input.label : input.label}`, detail: input.help }));
    return items.length > 0 ? { header: 'Options', items, partial } : undefined;
  }
  // Which blank the word fills: an option's value right after the option, else the next bare word.
  const earlier: Record<string, string> = {};
  let bare = 0;
  let input: InputDescription | undefined;
  const positions = action.inputs.filter((candidate) => 'position' in candidate.typed)
    .sort((a, b) => ('position' in a.typed ? a.typed.position : 0) - ('position' in b.typed ? b.typed.position : 0));
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.startsWith('--')) {
      const option = action.inputs.find((candidate) => 'flag' in candidate.typed && candidate.typed.flag === word);
      if (option && !switchValue(option)) {
        if (index === words.length - 1) { input = option; break; }
        earlier[option.id] = words[index + 1]!;
        index += 1;
      }
      continue;
    }
    const filled = positions[bare];
    if (filled) earlier[filled.id] = word;
    bare += 1;
  }
  input ??= positions[bare];
  if (!input) return undefined;
  const fixed = fixedChoices(input);
  if (fixed) {
    const items = fixed.filter((choice) => matches(partial, choice.value, choice.label))
      .map((choice) => ({ value: choice.value, label: `${choice.value}  ${choice.label}`, detail: choice.help }));
    return items.length > 0 ? { header: input.label, items, partial } : undefined;
  }
  if (!input.choices || !('list' in input.choices)) return undefined;
  const rows = readRows(input.choices.list, earlier);
  if (rows === undefined) return { header: input.label, items: [], partial, pending: true };
  const items = rows.filter((row) => matches(partial, row.value, row.label))
    .map((row) => ({ value: row.value, label: row.state ? `${row.label}  ${row.state}` : row.label, detail: row.detail }));
  return items.length > 0 ? { header: input.label, items, partial } : undefined;
}
