/**
 * The guided path in the terminal: what do you want to do, fill in the
 * blanks, one sentence says what is about to happen, then it is done and the
 * line that does the same is shown. Drawn with what both apps already have:
 * the picker (`openSelection`) for the action list, every choice and typed
 * text, the hidden line (`beginConcealedInput`) for secrets, and the confirm
 * dialog for the sentence. Escape at any step goes back one step; Escape on
 * the action list leaves.
 */
import type { SelectionItem, SelectionResult } from '../selection-modal.js';
import { readRefusal, formatRefusal } from '@goodvibes-jev/engine/errors';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { listByName, type ListRow } from './lists.js';
import { runForm } from './form.js';
import { openGuidedPanel } from './panel.js';
import { isCommandReport, renderCommandReport } from './report.js';
import {
  actionButton,
  actionDoneLine,
  actionSentence,
  effectiveRisk,
  fixedChoices,
  renderTypedLine,
  riskWords,
} from './typed-line.js';
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription, CommandReport, InputDescription } from './types.js';

/** Inputs at or above this count are asked as one form rather than one question at a time. */
export const FORM_THRESHOLD = 4;

const TYPED_PREFIX = '\u0000typed:';
const DEFAULT_ID = '\u0000default';

type Step<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'back' };

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

/** The action list a bare command opens: the report first, risk words on the right. */
export async function pickAction(command: CommandDescription<never>, ctx: CommandActionContext): Promise<ActionDescription<never> | undefined> {
  const ordered = [
    ...command.actions.filter((action) => action.id === command.report),
    ...command.actions.filter((action) => action.id !== command.report),
  ];
  const items: SelectionItem[] = ordered.map((action) => ({
    id: action.id,
    label: action.label,
    detail: actionSentence(action, Object.fromEntries(action.inputs.map((input) => [input.id, `<${input.label.toLowerCase()}>`]))),
    ...(action.risk !== 'none' ? { right: riskWords(action.risk) } : {}),
  }));
  const result = await pickFrom(ctx, `${command.title}  ·  What do you want to do?`, items, { primaryVerbLabel: 'Choose' });
  return result ? ordered.find((action) => action.id === result.item.id) : undefined;
}

/**
 * Walk the guided path from wherever the typed line left off: with no action,
 * from the action list; with an action, from its first missing blank. Resolves
 * once the action ran, or the person left.
 */
export async function runGuided(
  command: CommandDescription<never>,
  start: { readonly action?: ActionDescription<never> | undefined; readonly values?: ActionValues | undefined },
  ctx: CommandActionContext,
): Promise<void> {
  // Where the surface can push a kit modal, the panel holds the first screen and the forms.
  if (ctx.pushSurfaceModal) { await runInPanel(command, start, ctx); return; }
  let action = start.action;
  let values: Record<string, string> = { ...(start.values ?? {}) };
  const typedFirst = new Set(Object.keys(values).filter((id) => values[id] !== undefined && values[id] !== ''));
  for (;;) {
    if (!action) {
      action = await pickAction(command, ctx);
      if (!action) return;
      values = {};
      typedFirst.clear();
    }
    const asked = await fillInputs(command, action, values, typedFirst, ctx);
    if (asked === 'back') {
      if (start.action && action === start.action && !start.values) return;
      action = undefined;
      continue;
    }
    values = asked;
    if (action.lasts !== 'not-a-change') {
      const risk = effectiveRisk(action, values);
      const sentence = actionSentence(action, values);
      if (ctx.confirm) {
        const go = await ctx.confirm({
          title: action.label,
          body: risk === 'none' ? sentence : `${sentence}\n\nThis ${riskWords(risk)}.`,
          confirmLabel: actionButton(action),
          cancelLabel: 'Back',
          tone: risk === 'none' ? 'primary' : 'danger',
        });
        if (!go) {
          // Back to the blanks: the last one asked is asked again.
          const last = [...action.inputs].reverse().find((input) => !typedFirst.has(input.id));
          if (!last) { action = undefined; continue; }
          delete values[last.id];
          continue;
        }
      } else {
        ctx.print(sentence);
      }
    }
    await runAndSay(command, action, values, ctx);
    return;
  }
}

/** Ask the blanks still empty, one at a time or as one form; resolves the filled values or back. */
async function fillInputs(
  command: CommandDescription<never>,
  action: ActionDescription<never>,
  values: Record<string, string>,
  typedFirst: ReadonlySet<string>,
  ctx: CommandActionContext,
): Promise<Record<string, string> | 'back'> {
  const open = action.inputs.filter((input) => !typedFirst.has(input.id));
  if (open.length >= FORM_THRESHOLD) return runForm(command, action, values, ctx);
  let index = open.findIndex((input) => values[input.id] === undefined);
  if (index < 0) index = open.length;
  while (index < open.length) {
    const input = open[index]!;
    const where = `${action.label}${action.inputs.filter((candidate) => values[candidate.id]).map((candidate) => `  ›  ${candidate.kind === 'secret' ? '•••' : values[candidate.id]}`).join('')}`;
    const step = await askInput(command, action, input, values, ctx, where, `step ${index + 1} of ${open.length}`);
    if (step.kind === 'back') {
      if (index === 0) return 'back';
      index -= 1;
      delete values[open[index]!.id];
      continue;
    }
    values[input.id] = step.value;
    index += 1;
  }
  return values;
}

/** Ask the sentence before a change; true to go on. */
async function askSentence(action: ActionDescription<never>, values: ActionValues, ctx: CommandActionContext): Promise<boolean> {
  if (action.lasts === 'not-a-change') return true;
  const risk = effectiveRisk(action, values);
  const sentence = actionSentence(action, values);
  if (!ctx.confirm) { ctx.print(sentence); return true; }
  return ctx.confirm({
    title: action.label,
    body: risk === 'none' ? sentence : `${sentence}\n\nThis ${riskWords(risk)}.`,
    confirmLabel: actionButton(action),
    cancelLabel: 'Back',
    tone: risk === 'none' ? 'primary' : 'danger',
  });
}

/** Run the action and say what happened, how to undo it and the line that does the same. */
export async function runAndSay(command: CommandDescription<never>, action: ActionDescription<never>, values: ActionValues, ctx: CommandActionContext): Promise<void> {
  try {
    // The description was built for this surface's context (defineCommand), so its run takes this ctx.
    const run = action.run as unknown as (values: ActionValues, ctx: CommandActionContext) => Promise<string | CommandReport | void>;
    const detail = await run(values, ctx);
    const doneLine = actionDoneLine(action, values);
    const undo = action.undoneBy ? command.actions.find((candidate) => candidate.id === action.undoneBy) : undefined;
    const lines = [
      ...(doneLine ? [doneLine] : []),
      ...(isCommandReport(detail) ? [renderCommandReport(detail)] : typeof detail === 'string' && detail ? [detail] : []),
      ...(action.lasts === 'not-a-change' && action.inputs.length === 0 ? [] : [`${undo ? `Undo: ${undo.label}    ` : ''}The command for this is: ${renderTypedLine(command, action.id, values)}`]),
    ];
    if (lines.length > 0) ctx.print(lines.join('\n'));
  } catch (error) {
    const refused = readRefusal(error);
    ctx.print(refused ? formatRefusal(refused) : `${action.label} failed: ${summarizeError(error)}`);
  }
  ctx.renderRequest?.();
}

/** The guided path in the panel: first screen and forms in one modal, then the sentence, then the run. */
async function runInPanel(
  command: CommandDescription<never>,
  start: { readonly action?: ActionDescription<never> | undefined; readonly values?: ActionValues | undefined },
  ctx: CommandActionContext,
): Promise<void> {
  let next: { action?: ActionDescription<never> | undefined; values?: ActionValues | undefined; step?: number | undefined } = { ...start };
  for (;;) {
    const result = await openGuidedPanel(command, ctx, next);
    if (!result || result.kind === 'cancel') return;
    if (!(await askSentence(result.action, result.values, ctx))) {
      // Back: the form again, on its last step, with what was filled in.
      next = { action: result.action, values: result.values, step: Number.MAX_SAFE_INTEGER };
      continue;
    }
    await runAndSay(command, result.action, result.values, ctx);
    return;
  }
}
