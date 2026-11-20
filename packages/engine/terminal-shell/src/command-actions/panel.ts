/**
 * The guided panel: a bare described command's first screen and its action
 * forms, as one kit modal both terminal apps push on their modal stack.
 *
 *   /mcp  Connect tools from other programs                         esc
 *
 *    See your servers                        none connected yet
 *      Add a server…
 *      Choose what a server may do…
 *
 * A group row opens a short list of its actions. An action with blanks opens
 * its form a step at a time ("Add a server · step 1 of 2"), the blanks of one
 * step together, a suggested value marked as suggested, and under it the
 * line the form will run ("This will run: /mcp add weather -- npx ..."),
 * updated on each key. Enter goes on (or opens the list of a blank chosen
 * from a live list), tab moves between blanks, left and right change a
 * choice, Esc goes back one step.
 */
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from '../surface-modal-host.js';
import type { SelectionItem } from '../selection-modal.js';
import { tokenizeSlashCommand } from '../slash-command-parser.js';
import { beginModal, finishModal, scrollCountText, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.js';
import { drawList, type KitRow } from '../renderer/surface-kit-list.js';
import { activeTokens } from '../renderer/theme.js';
import { listByName } from './lists.js';
import { fixedChoices, isShown, listChoices, renderTypedLine, riskWords, withoutSecrets } from './typed-line.js';
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription, FirstScreenGroup, InputDescription } from './types.js';

export type PanelResult =
  | { readonly kind: 'run'; readonly action: ActionDescription<never>; readonly values: ActionValues }
  | { readonly kind: 'cancel' };

interface MenuRow { readonly label: string; readonly action?: ActionDescription<never>; readonly group?: FirstScreenGroup }

/** The first screen's rows: the declared rows (actions and groups), else every action. */
export function firstScreenRows(command: CommandDescription<never>): readonly MenuRow[] {
  const byId = new Map(command.actions.map((action) => [action.id, action]));
  if (!command.firstScreenRows) return command.actions.map((action) => ({ label: action.label, action }));
  return command.firstScreenRows.flatMap((row): MenuRow[] => {
    if (typeof row === 'string') { const action = byId.get(row); return action ? [{ label: action.label, action }] : []; }
    return [{ label: row.label, group: row }];
  });
}

function rowLabel(row: MenuRow): string {
  const opens = row.group !== undefined || (row.action !== undefined && row.action.inputs.length > 0);
  return opens && !row.label.endsWith('…') ? `${row.label}…` : row.label;
}

function stepsOf(action: ActionDescription<never>): number[] {
  return [...new Set(action.inputs.filter((input) => !('impliedBy' in input.typed) || fixedChoices(input)).map((input) => input.step ?? 1))].sort((a, b) => a - b);
}

/** How a list or repeated blank's typed text becomes its value (one entry per line). */
function valueFromText(input: InputDescription, text: string): string {
  if ('tail' in input.typed && input.kind === 'list') return [...tokenizeSlashCommand(`/x ${text}`)].slice(1).join('\n');
  if ('flag' in input.typed && input.typed.repeats === true) return text.split(/\s*,\s*/).filter(Boolean).join('\n');
  return text;
}
function textFromValue(input: InputDescription, value: string): string {
  if ('tail' in input.typed && input.kind === 'list') return value.split('\n').join(' ');
  if ('flag' in input.typed && input.typed.repeats === true) return value.split('\n').join(', ');
  return value;
}

export class GuidedPanel implements SurfaceModal {
  readonly name = 'guided-command';
  private mode: 'menu' | 'group' | 'form' = 'menu';
  private group: FirstScreenGroup | undefined;
  private selected = 0;
  private rowValues = new Map<string, string>();
  private action: ActionDescription<never> | undefined;
  private stepIndex = 0;
  private field = 0;
  private texts: Record<string, string> = {};
  private note = '';
  private picking = false;
  private settled = false;
  private host: SurfaceModalHost | undefined;
  private readonly startedInForm: boolean;

  constructor(
    private readonly command: CommandDescription<never>,
    private readonly ctx: CommandActionContext,
    start: { readonly action?: ActionDescription<never> | undefined; readonly values?: ActionValues | undefined; readonly step?: number | undefined },
    private readonly resolve: (result: PanelResult) => void,
  ) {
    this.startedInForm = start.action !== undefined;
    if (start.action) this.openForm(start.action, start.values ?? {}, start.step ?? 0);
    else this.readRowValues(firstScreenRows(command));
  }

  get waitingForOwner(): boolean { return !this.settled; }

  // -- state -------------------------------------------------------------

  private readRowValues(rows: readonly MenuRow[]): void {
    for (const row of rows) {
      const read = row.action?.rowValue as ((ctx: CommandActionContext) => Promise<string>) | undefined;
      if (!read || !row.action) continue;
      const id = row.action.id;
      void read(this.ctx).then((value) => { this.rowValues.set(id, value); this.ctx.renderRequest?.(); }, () => { /* the row shows no value */ });
    }
  }

  private rows(): readonly MenuRow[] {
    if (this.mode === 'group' && this.group) {
      const byId = new Map(this.command.actions.map((action) => [action.id, action]));
      return this.group.actions.flatMap((id) => { const action = byId.get(id); return action ? [{ label: action.label, action }] : []; });
    }
    return firstScreenRows(this.command);
  }

  private openForm(action: ActionDescription<never>, values: ActionValues, step: number): void {
    this.mode = 'form';
    this.action = action;
    this.texts = {};
    for (const input of action.inputs) {
      const value = values[input.id];
      if (value !== undefined) this.texts[input.id] = textFromValue(input, value);
      else if (fixedChoices(input) && input.required !== true) this.texts[input.id] = input.required.default;
    }
    this.stepIndex = Math.max(0, Math.min(step, stepsOf(action).length - 1));
    this.field = this.firstOpenField();
    this.note = '';
  }

  /** The values so far, with suggestions taken where nothing was typed. */
  values(): Record<string, string> {
    const action = this.action;
    if (!action) return {};
    const values: Record<string, string> = {};
    for (const input of action.inputs) {
      const text = this.texts[input.id];
      if (text !== undefined && text !== '') values[input.id] = valueFromText(input, text);
    }
    for (const input of action.inputs) {
      if ('impliedBy' in input.typed && values[input.id] === undefined) {
        const by = input.typed.impliedBy;
        values[input.id] = values[by.input] ? by.ifGiven : by.ifNot;
      }
    }
    for (const input of action.inputs) {
      if (values[input.id] === undefined) {
        const suggested = input.suggest?.(values);
        if (suggested) values[input.id] = suggested.value;
      }
    }
    return values;
  }

  /** The first blank of the step that still wants an answer (a choice that holds one is passed over). */
  private firstOpenField(): number {
    const values = this.values();
    const index = this.stepFields().findIndex((input) => !fixedChoices(input) && !values[input.id] && !this.texts[input.id]);
    return Math.max(0, index);
  }

  private stepFields(): readonly InputDescription[] {
    const action = this.action;
    if (!action) return [];
    const step = stepsOf(action)[this.stepIndex] ?? 1;
    const values = this.values();
    return action.inputs.filter((input) => (input.step ?? 1) === step && isShown(input, values) && (!('impliedBy' in input.typed) || fixedChoices(input) !== undefined));
  }

  private missingInStep(): InputDescription | undefined {
    const values = this.values();
    return this.stepFields().find((input) => input.required === true && !values[input.id]);
  }

  private settle(result: PanelResult): void {
    if (this.settled) return;
    this.settled = true;
    this.host?.close(this, 'done');
    this.resolve(result);
  }

  private back(): boolean {
    if (this.mode === 'form') {
      if (this.stepIndex > 0) { this.stepIndex -= 1; this.field = 0; return true; }
      if (this.startedInForm) return false;
      this.mode = this.group ? 'group' : 'menu';
      this.action = undefined;
      return true;
    }
    if (this.mode === 'group') { this.mode = 'menu'; this.group = undefined; this.selected = 0; return true; }
    return false;
  }

  private choose(): void {
    const row = this.rows()[this.selected];
    if (!row) return;
    if (row.group) {
      this.mode = 'group';
      this.group = row.group;
      this.selected = 0;
      this.readRowValues(this.rows());
      return;
    }
    if (!row.action) return;
    if (row.action.inputs.length === 0) { this.settle({ kind: 'run', action: row.action, values: {} }); return; }
    this.openForm(row.action, {}, 0);
  }

  private pick(input: InputDescription): void {
    const list = listChoices(input);
    if (!list || !this.ctx.openSelection) return;
    const open = this.ctx.openSelection;
    this.picking = true;
    const values = this.values();
    void listByName<CommandActionContext>(list.list).read(this.ctx, values, new AbortController().signal).then((rows) => {
      const items: SelectionItem[] = rows.map((row) => ({ id: row.value, label: row.label, ...(row.detail ? { detail: row.detail } : {}), ...(row.state ? { right: row.state } : {}) }));
      open(`${this.action?.label ?? ''}  ›  ${input.label}`, items, {
        allowSearch: true,
        primaryVerbLabel: 'Choose',
        ...(list.allowOther ? { customItem: (query: string) => query ? { id: query, label: `Use "${query}"`, detail: list.allowOther!.reason } : null } : {}),
      }, (result) => {
        this.picking = false;
        if (result) { this.texts[input.id] = result.item.id; this.field = Math.min(this.field + 1, this.stepFields().length - 1); }
        this.ctx.renderRequest?.();
      });
    }, () => { this.picking = false; this.note = `Could not read the choices for ${input.label}; type one instead.`; this.ctx.renderRequest?.(); });
  }

  private advance(): void {
    const fields = this.stepFields();
    const current = fields[this.field];
    if (current && listChoices(current) && !this.texts[current.id]) { this.pick(current); return; }
    const missing = this.missingInStep();
    if (missing) { this.note = `${missing.label} is needed.`; this.field = Math.max(0, fields.indexOf(missing)); return; }
    const action = this.action!;
    if (this.stepIndex < stepsOf(action).length - 1) { this.stepIndex += 1; this.field = this.firstOpenField(); this.note = ''; return; }
    this.settle({ kind: 'run', action, values: this.values() });
  }

  private cycle(input: InputDescription, delta: number): void {
    const choices = fixedChoices(input);
    if (!choices || choices.length === 0) return;
    const index = choices.findIndex((choice) => choice.value === this.texts[input.id]);
    this.texts[input.id] = choices[(index + delta + choices.length) % choices.length]!.value;
  }

  // -- keys --------------------------------------------------------------

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    this.host = host;
    if (this.picking) return;
    if (this.mode !== 'form') {
      const rows = this.rows();
      if (token.type !== 'key') return;
      const key = token.logicalName ?? '';
      if (key === 'up') this.selected = (this.selected - 1 + rows.length) % Math.max(1, rows.length);
      else if (key === 'down') this.selected = (this.selected + 1) % Math.max(1, rows.length);
      else if (key === 'enter') this.choose();
      return;
    }
    const fields = this.stepFields();
    const input = fields[this.field];
    // Some terminals deliver Tab as text: it moves between blanks, it is never typed into one.
    if (token.type === 'text' && token.value === '\t') { this.field = (this.field + 1) % Math.max(1, fields.length); return; }
    if (token.type === 'text') {
      if (!input || fixedChoices(input)) return;
      if (listChoices(input) && !listChoices(input)!.allowOther) return;
      this.texts[input.id] = (this.texts[input.id] ?? '') + token.value;
      this.note = '';
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'tab' || key === 'down') this.field = (this.field + 1) % Math.max(1, fields.length);
    else if (key === 'up') this.field = (this.field - 1 + fields.length) % Math.max(1, fields.length);
    else if ((key === 'left' || key === 'right') && input && fixedChoices(input)) this.cycle(input, key === 'left' ? -1 : 1);
    else if (key === 'backspace' && input && !fixedChoices(input)) this.texts[input.id] = (this.texts[input.id] ?? '').slice(0, -1);
    else if (key === 'enter') this.advance();
  }

  escape(): boolean {
    if (this.picking) return true;
    return this.back();
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    if (!this.settled) { this.settled = true; this.resolve({ kind: 'cancel' }); }
  }

  // -- drawing -----------------------------------------------------------

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return this.mode === 'form' ? this.renderForm(screenWidth, screenHeight) : this.renderMenu(screenWidth, screenHeight);
  }

  private frame(screenWidth: number, screenHeight: number, rows: number, hints: readonly KitHint[], sub?: string) {
    const t = activeTokens();
    return beginModal(screenWidth, screenHeight, {
      title: `/${this.command.name}`,
      ...(sub ? { sub } : {}),
      titleGlyph: { char: '', fg: t.text },
      hints,
      height: rows + 6 + (hints.length > 0 ? 2 : 0),
      center: true,
    });
  }

  private renderMenu(screenWidth: number, screenHeight: number): SurfaceLayer {
    const rows = this.rows();
    const f = this.frame(screenWidth, screenHeight, rows.length, [['↑↓', 'move'], ['⏎', 'choose']], this.group ? this.group.label : this.command.summary);
    // The kit list: the product's selection bar, starting at the title's column.
    const kitRows: KitRow[] = rows.map((row, index) => {
      const value = row.action ? (this.rowValues.get(row.action.id) ?? (row.action.risk !== 'none' ? riskWords(row.action.risk) : '')) : '';
      return { label: rowLabel(row), ...(value ? { right: value } : {}), selected: index === this.selected };
    });
    const listed = drawList(f.canvas, { mouseNavigation: true, rows: kitRows, top: f.top, bottom: f.bottom, x0: f.l + 1, x1: f.r, scrollKey: { owner: this, name: 'guided-menu' } });
    f.hintRight = scrollCountText(listed.above, listed.below);
    return finishModal(f);
  }

  private renderForm(screenWidth: number, screenHeight: number): SurfaceLayer {
    const t = activeTokens();
    const action = this.action!;
    const steps = stepsOf(action);
    const fields = this.stepFields();
    const values = this.values();
    const line = renderTypedLine(this.command, action.id, withoutSecrets(action, values));
    const f = this.frame(screenWidth, screenHeight, fields.length * 2 + 6, [['⏎', this.stepIndex < steps.length - 1 ? 'next' : 'done'], ['tab', 'field'], ['esc', 'back']]);
    // Text starts at the title's column; the form scrolls so the blank being answered is always shown.
    const l = f.l + 1;
    const width = f.r - l + 1;
    let y = f.top;
    f.canvas.put(l, y, `${action.label}${steps.length > 1 ? ` · step ${this.stepIndex + 1} of ${steps.length}` : ''}`, { fg: t.textMuted });
    y += 1;
    const question = action.stepTitles?.[this.stepIndex];
    if (question) { f.canvas.put(l, y, `   ${question}`, { fg: t.text }); y += 1; }
    const labelWidth = Math.min(22, Math.max(...fields.map((input) => input.label.length)) + 3);
    const inline = (input: InputDescription): boolean => {
      const choices = fixedChoices(input);
      return choices !== undefined && choices.length <= 3 && choices.reduce((sum, choice) => sum + choice.label.length + 5, 0) < width - 4;
    };
    const heightOf = (index: number, first: number): number =>
      inline(fields[index]!) ? 3 : index === first || inline(fields[index - 1]!) ? 2 : 1;
    // Rows left for blanks: the run line and its gap (and a note) stay at the bottom.
    const room = f.bottom - y - 2 - (this.note ? 2 : 0);
    let first = 0;
    const span = (from: number, to: number): number => { let total = 0; for (let k = from; k <= to; k++) total += heightOf(k, from); return total; };
    // One row is kept for the "more below" mark whenever a blank follows the window.
    const focus = Math.min(this.field, fields.length - 1);
    const budget = (to: number): number => room - (to < fields.length - 1 ? 1 : 0);
    while (first < focus && span(first, focus) > budget(focus)) first++;
    let last = Math.max(first, focus);
    while (last + 1 < fields.length && span(first, last + 1) <= budget(last + 1)) last++;
    if (first > 0) f.canvas.right(f.r, f.top, `↑ ${first} more above`, { fg: t.textFaint });
    for (let index = first; index <= last; index++) {
      const input = fields[index]!;
      const focused = index === this.field;
      const choices = fixedChoices(input);
      if (inline(input)) {
        // A short choice: its question on one line, its answers side by side under it.
        y += 1;
        f.canvas.put(l, y, `   ${input.help.endsWith('?') ? input.help : input.label}`, { fg: t.text });
        y += 1;
        let x = l + 3;
        for (const choice of choices!) {
          const on = this.texts[input.id] === choice.value;
          x = f.canvas.put(x, y, ` ${choice.label} `, on ? (focused ? { fg: t.selectedListItemText, bg: t.brand, bold: true } : { fg: t.text, bg: t.border }) : { fg: t.textMuted });
          x += 3;
        }
        y += 1;
        continue;
      }
      if (index === first || inline(fields[index - 1]!)) y += 1;
      const label = `   ${input.label}`.padEnd(labelWidth + 3);
      f.canvas.put(l, y, label, { fg: focused ? t.text : t.textMuted, bold: focused });
      let x = l + label.length;
      const typed = this.texts[input.id] ?? '';
      if (choices) {
        const chosen = choices.find((choice) => choice.value === typed);
        x = f.canvas.put(x, y, `‹ ${chosen?.label ?? (input.required === true ? 'choose' : input.required.defaultMeans)} ›`, { fg: focused ? t.brand : t.text });
        if (chosen?.risk && chosen.risk !== 'none') f.canvas.put(x + 2, y, riskWords(chosen.risk), { fg: t.textMuted });
      } else if (typed !== '') {
        const shown = input.kind === 'secret' ? '•'.repeat(Math.min(typed.length, 24)) : typed;
        x = f.canvas.put(x, y, shown.slice(-(f.r - x - 2)), { fg: t.brand });
        if (focused) f.canvas.put(x, y, '▏', { fg: t.textMuted });
      } else {
        const suggested = input.suggest?.(values);
        if (suggested) {
          x = f.canvas.put(x, y, suggested.value, { fg: t.text });
          f.canvas.put(x + 3, y, `suggested from the ${suggested.from}`, { fg: t.textMuted });
        } else {
          if (focused) x = f.canvas.put(x, y, '▏', { fg: t.textMuted });
          const hint = listChoices(input) ? (focused ? '⏎ to choose' : '') : input.required === true ? '' : input.required.defaultMeans;
          if (hint) f.canvas.put(x + 1, y, hint, { fg: t.textFaint });
        }
      }
      y += 1;
    }
    if (last < fields.length - 1) { y += 1; f.canvas.put(l + 3, y, `↓ ${fields.length - 1 - last} more below (tab)`, { fg: t.textFaint }); }
    if (this.note) { y += 1; f.canvas.put(l + 3, y, this.note, { fg: t.warning }); }
    const runY = Math.min(f.bottom, y + 2);
    const lead = '   This will run: ';
    f.canvas.put(l, runY, lead, { fg: t.textMuted });
    f.canvas.put(l + lead.length, runY, line.length > width - lead.length ? `${line.slice(0, width - lead.length - 1)}…` : line, { fg: t.text });
    return finishModal(f);
  }
}

/** Open the guided panel and resolve what the person chose (an action and its values) or that they left. */
export function openGuidedPanel(
  command: CommandDescription<never>,
  ctx: CommandActionContext,
  start: { readonly action?: ActionDescription<never> | undefined; readonly values?: ActionValues | undefined; readonly step?: number | undefined } = {},
): Promise<PanelResult> | undefined {
  const push = ctx.pushSurfaceModal;
  if (!push) return undefined;
  return new Promise((resolve) => push(new GuidedPanel(command, ctx, start, resolve)));
}
