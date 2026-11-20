/**
 * One question of the guided path: a choice from the picker (`openSelection`),
 * typed text through the picker's own line, or a secret on the hidden line
 * (`beginConcealedInput`). guided.ts asks inputs one at a time and form.ts a
 * whole form with these.
 */
import type { SelectionItem, SelectionResult } from '../selection-modal.js';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { listByName, type ListRow } from './lists.js';
import { fixedChoices, riskWords } from './typed-line.js';
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription, InputDescription } from './types.js';

const TYPED_PREFIX = '\u0000typed:';
const DEFAULT_ID = '\u0000default';

export type Step<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'back' };

export function pickFrom(ctx: CommandActionContext, title: string, items: SelectionItem[], options: Parameters<NonNullable<CommandActionContext['openSelection']>>[2] = {}): Promise<SelectionResult | null> {
  const open = ctx.openSelection;
  if (!open) return Promise.resolve(null);
  return new Promise((resolve) => open(title, items, { allowSearch: true, ...options }, resolve));
}

function concealed(ctx: CommandActionContext, label: string): Promise<string | null> {
  const begin = ctx.beginConcealedInput;
  if (!begin) return Promise.resolve(null);
  ctx.print(`${label}: type it below and press Enter (it is hidden and never kept in history). Esc goes back.`);
  return new Promise((resolve) => begin({ label, onSubmit: (value: string) => resolve(value), onCancel: () => resolve(null) }));
}

/** The rows a choice input offers: its fixed choices, or its live list read now. */
async function choiceRows(input: InputDescription, values: ActionValues, ctx: CommandActionContext): Promise<readonly ListRow[] | undefined> {
  const fixed = fixedChoices(input);
  if (fixed) return fixed.map((choice) => ({ value: choice.value, label: choice.label, ...(choice.help ? { detail: choice.help } : {}), ...(choice.risk && choice.risk !== 'none' ? { state: riskWords(choice.risk) } : {}) }));
  if (input.choices && 'list' in input.choices) {
    const controller = new AbortController();
    return listByName<CommandActionContext>(input.choices.list).read(ctx, values, controller.signal);
  }
  return undefined;
}

/** Ask one input. Resolves the answer, or back. */
export async function askInput(
  command: CommandDescription<never>,
  action: ActionDescription<never>,
  input: InputDescription,
  values: ActionValues,
  ctx: CommandActionContext,
  where: string,
  step = '',
): Promise<Step<string>> {
  const title = `${where}  ›  ${input.label}${step ? `   ${step}` : ''}`;
  if (input.kind === 'secret') {
    const value = await concealed(ctx, `${action.label}: ${input.label}`);
    return value === null ? { kind: 'back' } : { kind: 'value', value };
  }
  let rows: readonly ListRow[] | undefined;
  try {
    rows = await choiceRows(input, values, ctx);
  } catch (error) {
    ctx.print(`Could not read the choices for ${input.label}: ${summarizeError(error)}. Type a value instead.`);
    rows = [];
  }
  const optional = input.required !== true ? input.required : undefined;
  const items: SelectionItem[] = (rows ?? []).map((row) => {
    const right = [row.state, optional && row.value === optional.default ? 'usual choice' : undefined].filter(Boolean).join(', ');
    return { id: row.value, label: row.label, ...(row.detail ? { detail: row.detail } : {}), ...(right ? { right } : {}) };
  });
  if (optional && !items.some((item) => item.id === optional.default)) {
    items.unshift({ id: DEFAULT_ID, label: optional.default === '' ? 'Leave it out' : `Leave it as ${optional.default}`, detail: optional.defaultMeans, right: 'usual choice' });
  }
  const list = input.choices && !Array.isArray(input.choices) && 'list' in input.choices ? input.choices : undefined;
  const typedReason = rows === undefined ? (input.freeTextReason ?? input.help) : list?.allowOther?.reason;
  if (items.length === 0 && typedReason === undefined) {
    ctx.print(`${action.label}: there is no ${input.label.toLowerCase()} to choose from yet (${input.help.toLowerCase()}).`);
    return { kind: 'back' };
  }
  const none = items.length === 0 && rows !== undefined ? `  (none listed now; type one: ${typedReason})` : '';
  const result = await pickFrom(ctx, `${title}${none}`, items, {
    ...(typedReason !== undefined || rows === undefined ? { customItem: (query: string) => query ? { id: `${TYPED_PREFIX}${query}`, label: `Use "${query}"`, detail: typedReason ?? input.help } : null } : {}),
    ...(optional ? { preSelectId: items.some((item) => item.id === optional.default) ? optional.default : DEFAULT_ID } : {}),
    primaryVerbLabel: 'Choose',
  });
  if (!result) return { kind: 'back' };
  const id = result.item.id;
  if (id === DEFAULT_ID) return { kind: 'value', value: optional?.default ?? '' };
  return { kind: 'value', value: id.startsWith(TYPED_PREFIX) ? id.slice(TYPED_PREFIX.length) : id };
}
