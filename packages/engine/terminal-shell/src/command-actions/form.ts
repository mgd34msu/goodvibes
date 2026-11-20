/**
 * An action with four or more blanks is shown as one form: every blank with
 * its label and current answer, the usual choice already filled in and said in
 * words, and a last row that goes on to the sentence. Enter on a blank asks
 * it the way the step-by-step path does; Escape goes back. Drawn by each app's
 * picker renderer, so both apps show the same form.
 */
import type { SelectionItem } from '../selection-modal.js';
import { askInput, pickFrom } from './ask-input.js';
import { fixedChoices } from './typed-line.js';
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription, InputDescription } from './types.js';

const CONTINUE_ID = '\u0000continue';

function shownValue(input: InputDescription, values: ActionValues): string {
  const value = values[input.id];
  if (value === undefined || value === '') {
    const required = input.required;
    if (required === true) return '(needed)';
    const usual = fixedChoices(input)?.find((candidate) => candidate.value === required.default);
    return usual ? `${usual.label} (the usual)` : `(${required.defaultMeans})`;
  }
  if (input.kind === 'secret') return value.split('\n').map(() => '•••').join(', ');
  const choice = fixedChoices(input)?.find((candidate) => candidate.value === value);
  if (choice) return choice.label;
  return value.split('\n').join(', ');
}

/** Fill an action's blanks as one form; resolves the values, or back. */
export async function runForm(
  command: CommandDescription<never>,
  action: ActionDescription<never>,
  start: ActionValues,
  ctx: CommandActionContext,
): Promise<Record<string, string> | 'back'> {
  const values: Record<string, string> = { ...start };
  let note = '';
  let selected: string | undefined = action.inputs.find((input) => input.required === true && !values[input.id])?.id;
  for (;;) {
    const missing = action.inputs.filter((input) => input.required === true && !values[input.id]);
    const items: SelectionItem[] = [
      ...action.inputs.map((input) => ({
        id: input.id,
        label: input.label,
        desc: shownValue(input, values),
        detail: input.help,
        ...(input.required === true ? { right: values[input.id] ? '' : 'needed' } : {}),
      })),
      {
        id: CONTINUE_ID,
        label: missing.length > 0 ? `Continue (first fill in: ${missing.map((input) => input.label).join(', ')})` : 'Continue',
        detail: 'Shows what is about to happen; nothing is done until you confirm it.',
      },
    ];
    const result = await pickFrom(ctx, `${action.label}${note ? `  ·  ${note}` : ''}`, items, {
      allowSearch: false,
      primaryVerbLabel: 'Change',
      ...(selected ? { preSelectId: selected } : {}),
    });
    note = '';
    if (!result) return 'back';
    if (result.item.id === CONTINUE_ID) {
      if (missing.length === 0) return values;
      note = `${missing[0]!.label} is needed`;
      selected = missing[0]!.id;
      continue;
    }
    const input = action.inputs.find((candidate) => candidate.id === result.item.id);
    if (!input) continue;
    selected = input.id;
    const repeats = 'flag' in input.typed && input.typed.repeats === true;
    const step = await askInput(command, action, input, values, ctx, `${action.label}  ›  ${input.label}`);
    if (step.kind === 'back') continue;
    if (repeats && step.value !== '' && values[input.id]) values[input.id] = `${values[input.id]}\n${step.value}`;
    else values[input.id] = step.value;
    const next = action.inputs.find((candidate) => candidate.required === true && !values[candidate.id]);
    selected = next?.id ?? CONTINUE_ID;
  }
}
