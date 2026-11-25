/**
 * The typed form of a described command, both ways: a typed line to an action
 * and its values, and an action and values back to the line. Both directions
 * read the same description, so "The command for this is: ..." always prints a
 * line the command accepts.
 *
 * Grammar: `/name word [first] [second] [--option value | --switch]... [-- tail...]`.
 * The action word is compared case-folded; `--yes` is never a value (a line the
 * owner typed in full asks nothing; on a model's line it is ignored).
 */
import { quoteSlashCommandArg } from '../slash-command-parser.js';
import {
  effectiveRisk as capabilityEffectiveRisk,
  fillSentence as capabilityFillSentence,
  lastsWords as capabilityLastsWords,
  riskDoneLine,
} from '@goodvibes/engine/platform/platform/capabilities/words';
import {
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

/** The value an implied input takes from what was given: the first given input's meaning, else `ifNot`. */
export function impliedValue(by: { readonly input: string; readonly ifGiven: string; readonly ifNot: string; readonly orIfGiven?: readonly { readonly input: string; readonly value: string }[] | undefined }, values: ActionValues): string {
  if (values[by.input]) return by.ifGiven;
  return by.orIfGiven?.find((entry) => values[entry.input])?.value ?? by.ifNot;
}

/** The values with every implied input read from what was given (a web address given means "start it at an address"). */
export function withImplied(action: Pick<ActionShape, 'inputs'>, values: ActionValues): ActionValues {
  const out: Record<string, string> = { ...values };
  for (const input of action.inputs) {
    if ('impliedBy' in input.typed && out[input.id] === undefined) out[input.id] = impliedValue(input.typed.impliedBy, out);
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

/**
 * The typed words with the confirming `--yes` taken off. Words after `--` are
 * text and are never touched. A command whose last blank is free text
 * (`leadingFlagsOnly`) takes `--yes` only before its action word and among the
 * flags right after it, so the same word inside the text stays text; any other
 * command takes it wherever it stands before `--`.
 */
function withoutYes(args: readonly string[], leadingOnly: boolean, actionWordFirst: boolean): string[] {
  const cut = args.indexOf('--');
  const head = cut < 0 ? args : args.slice(0, cut);
  const after = cut < 0 ? [] : args.slice(cut);
  if (!leadingOnly) return [...head.filter((word) => word !== '--yes'), ...after];
  const kept: string[] = [];
  let seenAction = !actionWordFirst;
  let inFlags = true;
  for (const word of head) {
    if (word === '--yes' && (!seenAction || inFlags)) continue;
    if (!seenAction) { seenAction = true; kept.push(word); continue; }
    if (!word.startsWith('--')) inFlags = false;
    kept.push(word);
  }
  return [...kept, ...after];
}

/** Read a typed line (the words after the command name) against the description. */
export function parseTypedLine<Ctx>(description: CommandDescription<Ctx>, args: readonly string[]): ParsedLine {
  const single = singleAction(description);
  const leadingOnly = description.leadingFlagsOnly === true;
  const words = single ? ['', ...withoutYes(args, leadingOnly, false)] : withoutYes(args, leadingOnly, true);
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
      if ('impliedBy' in input.typed) values[input.id] = impliedValue(input.typed.impliedBy, values);
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
    // A --yes that was not a leading flag is a word of the text (the leading one was taken off above).
    if (leadingOnly && word === '--yes') { bare.push(word); continue; }
    if (word.startsWith('--') && word.length > 2) {
      const equals = word.indexOf('=');
      const flag = equals > 0 ? word.slice(0, equals) : word;
      const input = action.inputs.find((candidate) => 'flag' in candidate.typed && candidate.typed.flag === flag);
      if (!input) { problem = `/${description.name} ${action.word} has no option ${flag}.`; return done(); }
      const toggle = switchValue(input);
      if (toggle && equals < 0) { values[input.id] = toggle.on; continue; }
      let value = equals > 0 ? word.slice(equals + 1) : words[index + 1];
      if (value === undefined) { problem = `${flag} needs a value: ${input.label}.`; return done(); }
      if (equals < 0) index += 1;
      // A free-text option reads on to the next option (or `--`): `--title Tomato blight notes`.
      if ('flag' in input.typed && input.typed.untilNextFlag === true) {
        while (index + 1 < words.length && !words[index + 1]!.startsWith('--')) value = `${value} ${words[++index]!}`;
      }
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
      // The value is another action's word of this command ("/permissions add never ..."): name that action's line.
      const other = findAction(description, value);
      if (other && other !== action) problem += ` Use /${description.name} ${linePattern(other)}.`;
      return done();
    }
    values[input.id] = match.value;
  }
  return done();
}

/**
 * The values with every secret left out, for a line shown on screen or kept in
 * the transcript ("The command for this is", "This will run"): typed without
 * the secret, the line asks for it on a hidden line instead.
 */
export function withoutSecrets(action: Pick<ActionShape, 'inputs'>, values: ActionValues): ActionValues {
  const secret = new Set(action.inputs.filter((input) => input.kind === 'secret').map((input) => input.id));
  if (secret.size === 0) return values;
  return Object.fromEntries(Object.entries(values).filter(([id]) => !secret.has(id)));
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
    // Text holding a word that reads as an option (--yes, --to) goes after --, so it is read back as the same
    // text; so does any text after an option that reads on to the next option.
    else parts.push(...(tailValue.split(/\s+/).some((word) => word.startsWith('--')) || readsOn(action) ? ['--'] : []), tailValue);
  }
  return parts.join(' ');
}

/** True when one of the action's options reads every word up to the next option (`untilNextFlag`). */
function readsOn(action: ActionShape): boolean {
  return action.inputs.some((input) => 'flag' in input.typed && input.typed.untilNextFlag === true);
}

/** `block <server> <tool> [--keep]`: the action's typed pattern, read from its inputs. */
export function linePattern(action: ActionShape): string {
  const parts = [action.word];
  const positions = action.inputs.filter((input) => 'position' in input.typed)
    .sort((a, b) => ('position' in a.typed ? a.typed.position : 0) - ('position' in b.typed ? b.typed.position : 0));
  for (const input of positions) {
    const name = `<${input.label.toLowerCase()}>`;
    // A secret left off the line is asked for on a hidden line, so the form without it comes first.
    parts.push(input.required === true && input.kind !== 'secret' ? name : `[${name}]`);
  }
  const tail = action.inputs.find((input) => 'tail' in input.typed);
  const tailPart = tail
    ? tail.kind === 'list' ? `[-- <${tail.label.toLowerCase()}>...]` : tail.required === true ? `<${tail.label.toLowerCase()}...>` : `[<${tail.label.toLowerCase()}...>]`
    : '';
  // An option that reads on to the next option would take text written after it: the text goes first.
  const tailFirst = tail !== undefined && tail.kind !== 'list' && readsOn(action);
  if (tailFirst) parts.push(tailPart);
  for (const input of action.inputs) {
    if (!('flag' in input.typed)) continue;
    const toggle = switchValue(input);
    parts.push(toggle ? `[${input.typed.flag}]` : `[${input.typed.flag} <${input.label.toLowerCase()}>]${isRepeating(input) ? '...' : ''}`);
  }
  if (!tailFirst) parts.push(tailPart);
  return parts.filter(Boolean).join(' ');
}

/** How long a change with these values lasts, as the sentence's last words; empty for a read. */
export function lastsWords(action: ActionShape, values: ActionValues): string {
  return capabilityLastsWords(action, values);
}

/** The action's risk with these values: a chosen value can raise it (a looser trust mode). One rule, read by the gate too. */
export function effectiveRisk(action: ActionShape, values: ActionValues): ActionRisk {
  return capabilityEffectiveRisk(action, values);
}

/** The risk words for an action, or empty for none. */
export function riskWords(risk: ActionRisk): string {
  return risk === 'none' ? '' : RISK_WORDS[risk];
}

/** Fill `{input}` blanks and `{lasts}`; a blank with no value reads as its label in angle brackets. */
export function fillSentence(template: string, values: ActionValues, lasts: string): string {
  return capabilityFillSentence(template, values, lasts);
}

/** The action's sentence for these values. */
export function actionSentence(action: ActionShape, values: ActionValues): string {
  return fillSentence(action.sentence, values, lastsWords(action, values));
}

/** The action's done line for these values; empty for an action that has none (a read). */
export function actionDoneLine(action: ActionShape, values: ActionValues): string {
  return action.done ? fillSentence(action.done, values, lastsWords(action, values)) : '';
}

const LEADING_ADVERB = /^(never|always)$/i;
/** Words that end the button: an article or determiner starting the object, or a preposition or question word. */
const OBJECT_START = /^(a|an|the|one|its|this|all|every|to|from|for|beyond|on|it|what|where|whether|how|who|like|about|into|as|of|under|with|before|after|in|at|by|your|my|that|these|those|two|some)$/i;
/** A particle that belongs to the verb ("Sign in", "Go back", "Switch ... on"). */
const PARTICLE = /^(in|out|on|off|back|aside|over|up|down|away|again)$/i;
/** Verbs whose particle is part of them wherever it stands ("Bring in a setup", "Take a step out of a plan"). */
const PHRASAL = /^(bring|take|put|go|hold|sign|switch|roll|set|throw|carry|give)$/i;
const DETERMINER = /^(a|an|the|one|its|this|all|every|your|my|that|these|those|some|two)$/i;
/** An object a button says as a pronoun: "Schedule something to run" is confirmed with "Schedule it". */
const PRONOUN: Readonly<Record<string, string>> = { something: 'it', anything: 'it', everything: 'it', someone: 'them' };

/**
 * The confirming button's words, read from the label: its verb (after
 * "Never"/"Always"), the particle that belongs to the verb, either right after
 * it ("Sign in", "Go back", "Bring in") or closing the object ("Switch a hook
 * on" -> "Switch on", "Take a plugin out of ..." -> "Take out"), a verb it
 * continues ("Stop blocking"), or a pronoun for an unnamed object ("Schedule
 * something to run" -> "Schedule it"). An action whose words cannot be read
 * this way names its button in its description (`button`).
 */
export function actionButton(action: ActionShape): string {
  if (action.button) return action.button;
  const words = action.label.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let index = 0;
  while (index < words.length - 1 && LEADING_ADVERB.test(words[index]!)) out.push(words[index++]!);
  out.push(words[index]!);
  const rest = words.slice(index + 1);
  const next = rest[0];
  if (next === undefined) return out.join(' ');
  const pronoun = PRONOUN[next.toLowerCase()];
  if (pronoun) return [...out, rest.length === 2 && PARTICLE.test(rest[1]!) && rest[1]!.toLowerCase() !== 'again' ? rest[1]! : pronoun].join(' ');
  // A particle right after the verb, unless it starts a place ("Continue in a copy").
  const verb = out[out.length - 1]!;
  if (PARTICLE.test(next) && (PHRASAL.test(verb) || !(rest[1] && DETERMINER.test(rest[1])))) return [...out, next].join(' ');
  if (/ing$/i.test(next) && next.length > 4) return [...out, next].join(' ');
  // A particle closing an object that starts with a determiner: the label's last word, or followed by "of" or "to".
  if (DETERMINER.test(next) && PHRASAL.test(verb)) {
    const closing = rest.findIndex((word, at) => at > 1 && PARTICLE.test(word) && word.toLowerCase() !== 'again' && (at === rest.length - 1 || /^(of|to)$/i.test(rest[at + 1] ?? '')));
    if (closing > 0) return [...out, rest[closing]!].join(' ');
  }
  if (OBJECT_START.test(next)) return out.join(' ');
  // A bare object noun: keep words up to the next object start ("Install hooks", "Save memory").
  const stop = rest.findIndex((word) => OBJECT_START.test(word));
  return [...out, ...(stop < 0 ? rest : rest.slice(0, stop))].join(' ');
}

/**
 * The control that submits a filled form: the action's button, with the
 * amount when the action spends money ("Approve (at most 25.00)").
 */
export function actionSubmitLabel(action: ActionShape, values: ActionValues): string {
  const button = actionButton(action);
  if (effectiveRisk(action, values) !== 'spends-money') return button;
  const money = action.inputs.find((input) => input.kind === 'money' && values[input.id]);
  return money ? `${button} (${money.label.toLowerCase()} ${values[money.id]})` : button;
}

/**
 * What the act did, said with the result of an action that ran: its own words
 * (`riskDone`) when it has them, else its risk's ("This loosened a
 * protection."); empty for no risk.
 */
export function actionRiskDoneLine(action: ActionShape & Pick<ActionDescription<never>, 'riskDone'>, values: ActionValues): string {
  // The one chooser (platform capabilities/outcome.ts): the act's own line, or the chosen value's, else the risk's words.
  return riskDoneLine(action, values);
}

/** What submitting does, in the words the typed line's question uses: the sentence, then its risk. */
export function actionConsequence(action: ActionShape, values: ActionValues): string {
  const risk = effectiveRisk(action, values);
  const sentence = actionSentence(action, values);
  return risk === 'none' ? sentence : `${sentence} This ${riskWords(risk)}.`;
}

// What an action sends to its operator method; defined once with the capabilities, which the daemon runs too.
export { operatorInputFromValues } from '@goodvibes/engine/platform/platform/capabilities/words';
