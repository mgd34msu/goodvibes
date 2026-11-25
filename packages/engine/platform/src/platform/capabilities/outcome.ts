/**
 * The words a capability says before and after it runs, filled from its
 * values: the same sentence and done line on a typed line, in a form, in the
 * daemon's answer and on a script's output. A secret input never fills a
 * blank.
 */
import { effectiveRisk } from './risk.js';
import { LASTS_WORDS, RISK_DONE_WORDS, type ActionLasts, type ActionRisk, type ActionValues, type CapabilityResult, type FixedChoice, type InputDescription } from './types.js';

interface Worded {
  readonly sentence: string;
  readonly done: string;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly risk: ActionRisk;
  readonly riskDone?: string | undefined;
  readonly inputs: readonly InputDescription[];
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

/** How long the change lasts, in words: the action's own, or the chosen value's. */
export function lastsWords(action: Pick<Worded, 'lasts' | 'inputs'>, values: ActionValues): string {
  const lasts = action.lasts;
  if (lasts === 'not-a-change') return '';
  if (lasts === 'session' || lasts === 'kept') return LASTS_WORDS[lasts];
  const input = action.inputs.find((candidate) => candidate.id === lasts.byInput);
  const choices = input && Array.isArray(input.choices) ? input.choices as readonly FixedChoice[] : undefined;
  const chosen = input ? choices?.find((choice) => choice.value === values[input.id]) : undefined;
  return LASTS_WORDS[chosen?.lasts ?? 'session'];
}

/** How a secret input is shown wherever its value would be: hidden, with its length only. */
export function hiddenSecret(value: string): string {
  return `(hidden, ${value.length} character${value.length === 1 ? '' : 's'})`;
}

/** The values with every secret input's value taken out, for any line, record or ask that is printed, kept or sent. */
export function shownValues(action: Pick<Worded, 'inputs'>, values: ActionValues): ActionValues {
  const secret = new Set(action.inputs.filter((input) => input.kind === 'secret').map((input) => input.id));
  return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, secret.has(id) ? hiddenSecret(value) : value]));
}

/**
 * What a run says: the done line, the result's own words, and what its risk
 * did ("This loosened a protection."). The lines a person reads under the
 * command, and the text a model or a script is given.
 */
export function capabilityOutcomeText(action: Worded, values: ActionValues, result: CapabilityResult): string {
  const shown = shownValues(action, values);
  const done = action.done ? fillSentence(action.done, shown, lastsWords(action, values)) : '';
  const risk = effectiveRisk(action, values);
  const riskDone = risk === 'none' ? '' : `This ${RISK_DONE_WORDS[risk]}${action.riskDone ? `: ${fillSentence(action.riskDone, shown, '')}` : ''}.`;
  return [done, result.text, riskDone].filter((line) => line.length > 0).join('\n');
}
