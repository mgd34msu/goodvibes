/**
 * The typed form of a described command, both ways: a typed line to an action
 * and its values, and an action and values back to the line. Both directions
 * read the same description, so "The command for this is: ..." always prints a
 * line the command accepts.
 *
 * Grammar: `/name word [first] [second] [--option value | --switch]... [-- tail...]`.
 * The action word is compared case-folded; `--yes` is the owner's answer to the
 * question in advance and is never a value.
 */
import { quoteSlashCommandArg } from '../slash-command-parser.js';
import {
  LASTS_WORDS,
  RISK_WORDS,
  type ActionDescription,
  type ActionRisk,
  type ActionShape,
  type ActionValues,
  type CommandDescription,
  type CommandShape,
  type FixedChoice,
  type InputDescription,
  type ListChoices,
} from './types.js';

export type ParsedLine =
  | {
      readonly action: ActionDescription<never>;
      readonly values: Record<string, string>;
      readonly missing: readonly InputDescription[];
      /** The inputs the line itself gave (the rest hold their defaults). */
      readonly given: readonly string[];
      /** Set when the line names the action but cannot be read as its inputs. */
      readonly problem?: string | undefined;
    }
  | { readonly unknownWord: string }
  | { readonly bare: true };

/** Fixed choices of an input, or undefined when its choices come from a live list (or it has none). */
export function fixedChoices(input: InputDescription): readonly FixedChoice[] | undefined {
  return Array.isArray(input.choices) ? (input.choices as readonly FixedChoice[]) : undefined;
}

/** The values with every implied input read from what was given (a web address given means "start it at an address"). */
export function withImplied(action: Pick<ActionShape, 'inputs'>, values: ActionValues): ActionValues {
  const out: Record<string, string> = { ...values };
  for (const input of action.inputs) {
    if ('impliedBy' in input.typed && out[input.id] === undefined) {
      const by = input.typed.impliedBy;
      out[input.id] = out[by.input] ? by.ifGiven : by.ifNot;
    }
  }
  return out;
}

/** The live list an input chooses from, or undefined when it has fixed choices or none. */
export function listChoices(input: InputDescription): ListChoices | undefined {
  return input.choices !== undefined && !Array.isArray(input.choices) ? (input.choices as ListChoices) : undefined;
}

/** Whether an input is asked with these values (one shown only when another holds a value). */
export function isShown(input: InputDescription, values: ActionValues): boolean {
  return !input.showWhen || values[input.showWhen.input] === input.showWhen.is;
}

/** An option typed as a bare switch: present means the one non-default value. */
export function switchValue(input: InputDescription): { readonly on: string; readonly off: string } | undefined {
  if (!('flag' in input.typed)) return undefined;
  const off = input.required === true ? '' : input.required.default;
  if (input.typed.switchOn !== undefined) return { on: input.typed.switchOn, off };
  if (input.kind === 'yes-no') return { on: 'yes', off: off || 'no' };
  return undefined;
}

function isRepeating(input: InputDescription): boolean {
  return 'flag' in input.typed && input.typed.repeats === true;
}

function findAction<Ctx>(description: CommandDescription<Ctx>, word: string): ActionDescription<Ctx> | undefined {
  const folded = word.toLowerCase();
  return description.actions.find((action) => action.word === folded);
}

/**
 * The one action of a single-action command (`/clear`, `/title <text>`): a
 * command with exactly one action whose word is empty. Its line has no action
 * word; the command name alone runs it (or asks its first missing blank).
 */
export function singleAction<A extends { readonly word: string }>(description: { readonly actions: readonly A[] }): A | undefined {
  const only = description.actions.length === 1 ? description.actions[0] : undefined;
  return only && only.word === '' ? only : undefined;
}

/** Read a typed line (the words after the command name) against the description. */
export function parseTypedLine<Ctx>(description: CommandDescription<Ctx>, args: readonly string[]): ParsedLine {
  const single = singleAction(description);
  const words = single ? ['', ...args.filter((word) => word !== '--yes')] : args.filter((word) => word !== '--yes');
  if (words.length === 0) return { bare: true };
  const action = single ?? findAction(description, words[0]!);
  if (!action) return { unknownWord: words[0]! };
  const values: Record<string, string> = {};
  const positions = action.inputs.filter((input) => 'position' in input.typed)
    .sort((a, b) => ('position' in a.typed ? a.typed.position : 0) - ('position' in b.typed ? b.typed.position : 0));
  const tail = action.inputs.find((input) => 'tail' in input.typed);
  const bare: string[] = [];
  const tailWords: string[] = [];
  let problem: string | undefined;
  const done = (): ParsedLine => {
    const given = Object.keys(values);
    for (const input of action.inputs) {
      if ('impliedBy' in input.typed) {
        const by = input.typed.impliedBy;
        values[input.id] = values[by.input] ? by.ifGiven : by.ifNot;
      }
    }
    for (const input of action.inputs) {
      if (values[input.id] === undefined && input.required !== true) values[input.id] = input.required.default;
    }
    const missing = action.inputs.filter((input) => input.required === true && isShown(input, values) && (values[input.id] === undefined || values[input.id] === ''));
    return { action: action as ActionDescription<never>, values, missing, given, ...(problem ? { problem } : {}) };
  };
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--') {
      if (!tail) { problem = `/${description.name} ${action.word} takes nothing after --.`; return done(); }
      tailWords.push(...words.slice(index + 1));
      break;
    }
    if (word.startsWith('--') && word.length > 2) {
      const equals = word.indexOf('=');
      const flag = equals > 0 ? word.slice(0, equals) : word;
      const input = action.inputs.find((candidate) => 'flag' in candidate.typed && candidate.typed.flag === flag);
      if (!input) { problem = `/${description.name} ${action.word} has no option ${flag}.`; return done(); }
      const toggle = switchValue(input);
      if (toggle && equals < 0) { values[input.id] = toggle.on; continue; }
      const value = equals > 0 ? word.slice(equals + 1) : words[index + 1];
      if (value === undefined) { problem = `${flag} needs a value: ${input.label}.`; return done(); }
      if (equals < 0) index += 1;
      values[input.id] = isRepeating(input) && values[input.id] ? `${values[input.id]}\n${value}` : value;
      continue;
    }
    bare.push(word);
  }
  positions.forEach((input, index) => {
    const value = bare[index];
    if (value !== undefined) values[input.id] = value;
  });
  const extra = bare.slice(positions.length);
  if (extra.length > 0) {
    if (tail) tailWords.unshift(...extra);
    else { problem = `/${description.name} ${action.word} does not take "${extra.join(' ')}".`; return done(); }
  }
  if (tail && tailWords.length > 0) values[tail.id] = tailWords.join(tail.kind === 'list' ? '\n' : ' ');
  for (const input of action.inputs) {
    const choices = fixedChoices(input);
    const value = values[input.id];
    if (!choices || value === undefined) continue;
    const match = choices.find((choice) => choice.value.toLowerCase() === value.toLowerCase());
    if (!match) {
      problem = `${input.label}: "${value}" is not one of ${choices.map((choice) => choice.value).join(', ')}.`;
      return done();
    }
    values[input.id] = match.value;
  }
  return done();
}

/** The line that runs `actionId` with `values`; defaults are left out, so the line is the shortest that means the same. */
export function renderTypedLine(description: CommandShape, actionId: string, given: ActionValues): string {
  const action = description.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`/${description.name} has no action ${actionId}.`);
  const values = withImplied(action, given);
  const parts = action.word ? [`/${description.name}`, action.word] : [`/${description.name}`];
  const positions = action.inputs.filter((input) => 'position' in input.typed)
    .sort((a, b) => ('position' in a.typed ? a.typed.position : 0) - ('position' in b.typed ? b.typed.position : 0));
  for (const input of positions) {
    const value = values[input.id];
    if (value === undefined || value === '') break;
    if (input.required !== true && value === input.required.default && positions.indexOf(input) === positions.length - 1) break;
    parts.push(quoteSlashCommandArg(value));
  }
  for (const input of action.inputs) {
    if (!('flag' in input.typed) || !isShown(input, values)) continue;
    const value = values[input.id];
    if (value === undefined || value === '') continue;
    if (input.required !== true && value === input.required.default) continue;
    const toggle = switchValue(input);
    if (toggle) { if (value === toggle.on) parts.push(input.typed.flag); continue; }
    for (const one of isRepeating(input) ? value.split('\n') : [value]) parts.push(input.typed.flag, quoteSlashCommandArg(one));
  }
  const tail = action.inputs.find((input) => 'tail' in input.typed);
  const tailValue = tail && isShown(tail, values) ? values[tail.id] : undefined;
  if (tail && tailValue) {
    if (tail.kind === 'list') parts.push('--', ...tailValue.split('\n').map(quoteSlashCommandArg));
    else parts.push(tailValue);
  }
  return parts.join(' ');
}

/** `block <server> <tool> [--keep]`: the action's typed pattern, read from its inputs. */
export function linePattern(action: ActionShape): string {
  const parts = [action.word];
  const positions = action.inputs.filter((input) => 'position' in input.typed)
    .sort((a, b) => ('position' in a.typed ? a.typed.position : 0) - ('position' in b.typed ? b.typed.position : 0));
  for (const input of positions) {
    const name = `<${input.label.toLowerCase()}>`;
    parts.push(input.required === true ? name : `[${name}]`);
  }
  for (const input of action.inputs) {
    if (!('flag' in input.typed)) continue;
    const toggle = switchValue(input);
    parts.push(toggle ? `[${input.typed.flag}]` : `[${input.typed.flag} <${input.label.toLowerCase()}>]${isRepeating(input) ? '...' : ''}`);
  }
  const tail = action.inputs.find((input) => 'tail' in input.typed);
  if (tail) {
    const name = `<${tail.label.toLowerCase()}...>`;
    parts.push(tail.kind === 'list' ? `[-- <${tail.label.toLowerCase()}>...]` : tail.required === true ? name : `[${name}]`);
  }
  return parts.filter(Boolean).join(' ');
}

/** How long a change with these values lasts, as the sentence's last words; empty for a read. */
export function lastsWords(action: ActionShape, values: ActionValues): string {
  const lasts = action.lasts;
  if (lasts === 'not-a-change') return '';
  if (lasts === 'session' || lasts === 'kept') return LASTS_WORDS[lasts];
  const input = action.inputs.find((candidate) => candidate.id === lasts.byInput);
  const chosen = input ? fixedChoices(input)?.find((choice) => choice.value === values[input.id]) : undefined;
  return LASTS_WORDS[chosen?.lasts ?? 'session'];
}

/** The action's risk with these values: a chosen value can raise it (a looser trust mode). */
export function effectiveRisk(action: ActionShape, values: ActionValues): ActionRisk {
  if (action.risk !== 'none') return action.risk;
  for (const input of action.inputs) {
    const chosen = fixedChoices(input)?.find((choice) => choice.value === values[input.id]);
    if (chosen?.risk && chosen.risk !== 'none') return chosen.risk;
  }
  return 'none';
}

/** The risk words for an action, or empty for none. */
export function riskWords(risk: ActionRisk): string {
  return risk === 'none' ? '' : RISK_WORDS[risk];
}

/** Fill `{input}` blanks and `{lasts}`; a blank with no value reads as its label in angle brackets. */
export function fillSentence(template: string, values: ActionValues, lasts: string): string {
  return template
    .replace(/\{lasts\}/g, lasts)
    .replace(/\{([a-zA-Z0-9_-]+)\}/g, (_whole, id: string) => values[id] !== undefined && values[id] !== '' ? values[id]! : `<${id}>`)
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The action's sentence for these values. */
export function actionSentence(action: ActionShape, values: ActionValues): string {
  return fillSentence(action.sentence, values, lastsWords(action, values));
}

/** The action's done line for these values; empty for an action that has none (a read). */
export function actionDoneLine(action: ActionShape, values: ActionValues): string {
  return action.done ? fillSentence(action.done, values, lastsWords(action, values)) : '';
}

/** The confirming button's words: the label up to its object ("Stop blocking a tool" → "Stop blocking"). */
export function actionButton(action: ActionShape): string {
  const words = action.label.split(/\s+/);
  const stop = words.findIndex((word, index) => index > 0 && /^(a|an|the|one|its|this|all|every|to|from|for|beyond|on|it)$/i.test(word));
  const kept = stop > 0 ? words.slice(0, stop) : words;
  return kept.join(' ');
}
