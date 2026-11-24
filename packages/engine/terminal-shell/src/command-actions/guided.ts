/**
 * The guided path in the terminal: what do you want to do, fill in the
 * blanks, then it is done (the blanks filled in are the request: nothing is
 * asked after them) and the line that does the same is shown, with what its
 * risk did. Only a row with no blank, chosen from the list, says what it does
 * and asks first. Drawn with what both apps already have: the picker
 * (`openSelection`) for the action list, every choice and typed text, the
 * hidden line (`beginConcealedInput`) for secrets, and the confirm dialog for
 * that one question. Escape at any step goes back one step; Escape on the
 * action list leaves.
 */
import type { SelectionItem } from '../selection-modal.js';
import { readRefusal, formatRefusal } from '@goodvibes/engine/errors';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { askInput, pickFrom } from './ask-input.js';
import { runForm } from './form.js';
import { openGuidedPanel } from './panel.js';
import { isCommandReport, renderCommandReport } from './report.js';
import {
  actionButton,
  actionDoneLine,
  actionRiskDoneLine,
  actionSentence,
  effectiveRisk,
  renderTypedLine,
  riskWords,
  singleAction,
  withoutSecrets,
} from './typed-line.js';
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription, CommandReport } from './types.js';

/** Inputs at or above this count are asked as one form rather than one question at a time. */
export const FORM_THRESHOLD = 4;

export { askInput, pickFrom } from './ask-input.js';

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
  // A single-action command has no list to choose from: it starts at its action.
  const single = start.action ? undefined : singleAction(command);
  if (single) {
    start = { ...start, action: single };
    // Its name typed is the whole line: it runs at once.
    if (single.inputs.length === 0) {
      await runAndSay(command, single, {}, ctx);
      return;
    }
  }
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
    // Filled in and submitted, it is the request: it runs at once. Only a row
    // chosen from the list with no blank to fill (nothing typed, nothing
    // submitted) says what it does and asks first; Back is the list again.
    if (action.inputs.length === 0 && !(await askSentence(action, values, ctx))) {
      action = undefined;
      continue;
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
  // Its blanks are only typed: chosen from the list, it runs with what was typed and its defaults.
  if (action.blanksTypedOnly) return { ...Object.fromEntries(action.inputs.flatMap((input) => input.required === true ? [] : [[input.id, input.required.default]])), ...values };
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
  if (action.lasts === 'not-a-change' || action.asksItself) return true;
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
    const riskDone = actionRiskDoneLine(action, values);
    const undo = action.undoneBy ? command.actions.find((candidate) => candidate.id === action.undoneBy) : undefined;
    const lines = [
      ...(doneLine ? [doneLine] : []),
      ...(isCommandReport(detail) ? [renderCommandReport(detail)] : typeof detail === 'string' && detail ? [detail] : []),
      ...(riskDone ? [riskDone] : []),
      ...(action.lasts === 'not-a-change' && action.inputs.length === 0 ? [] : [`${undo ? `Undo: ${undo.label}    ` : ''}The command for this is: ${renderTypedLine(command, action.id, withoutSecrets(action, values))}`]),
    ];
    if (lines.length > 0) ctx.print(lines.join('\n'));
  } catch (error) {
    const refused = readRefusal(error);
    ctx.print(refused ? formatRefusal(refused) : `${action.label} failed: ${summarizeError(error)}`);
  }
  ctx.renderRequest?.();
}

/**
 * The guided path in the panel: first screen and forms in one modal, then the
 * run. A submitted form is the request and runs at once; a row with no blank,
 * chosen from the list, says what it does and asks first (Back: the list again).
 */
async function runInPanel(
  command: CommandDescription<never>,
  start: { readonly action?: ActionDescription<never> | undefined; readonly values?: ActionValues | undefined },
  ctx: CommandActionContext,
): Promise<void> {
  let next: { action?: ActionDescription<never> | undefined; values?: ActionValues | undefined; step?: number | undefined } = { ...start };
  for (;;) {
    const result = await openGuidedPanel(command, ctx, next);
    if (!result || result.kind === 'cancel') return;
    if (result.action.inputs.length === 0 && !(await askSentence(result.action, result.values, ctx))) {
      next = {};
      continue;
    }
    await runAndSay(command, result.action, result.values, ctx);
    return;
  }
}
