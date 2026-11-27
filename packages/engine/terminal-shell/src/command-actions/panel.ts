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
 * updated on each key. On the last step the Enter key is named for what it
 * does ("⏎ Send") and what submitting does is said above that line; the
 * submitted form is the request. Enter goes on (or opens the list of a blank chosen
 * from a live list), tab moves between blanks, left and right change a
 * choice, Esc goes back one step.
 */
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from '../surface-modal-host.js';
import type { SelectionItem } from '../selection-modal.js';
import { tokenizeSlashCommand } from '../slash-command-parser.js';
import { beginModal, finishModal, MODAL_MARK_INSET, scrollCountText, standardModalWidth, wrapLines, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.js';
import { drawList, type KitRow } from '../renderer/surface-kit-list.js';
import { activeTokens } from '../renderer/theme.js';
import { listByName, valuesAsShown } from './lists.js';
import { actionConsequence, actionSubmitLabel, fixedChoices, impliedValue, isShown, listChoices, renderTypedLine, riskWords, withoutSecrets } from './typed-line.js';
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

/** An action's optional blanks at their defaults: what it runs with when it shows no form. */
function defaultValues(action: ActionDescription<never>): ActionValues {
  return Object.fromEntries(action.inputs.flatMap((input) => input.required === true ? [] : [[input.id, input.required.default]]));
}

/** The form's steps; inputs a place already gave (`given`) are not asked, so a step of only those is not shown. */
function stepsOf(action: ActionDescription<never>, given: ReadonlySet<string> = new Set()): number[] {
  return [...new Set(action.inputs.filter((input) => !given.has(input.id) && (!('impliedBy' in input.typed) || fixedChoices(input))).map((input) => input.step ?? 1))].sort((a, b) => a - b);
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
  /** The blank the note is about (one left empty), drawn under that blank; undefined for a note about the form. */
  private noteFor: string | undefined;
  private picking = false;
  private settled = false;
  private host: SurfaceModalHost | undefined;
  private readonly startedInForm: boolean;
  /** A form opened from a place: titled with the place, and no command line is shown (places/place-modal.ts). */
  private readonly place: GuidedPanelStart['place'];
  /** Inputs the place gave from its selected item: kept, never asked. */
  private readonly given: ReadonlySet<string>;

  constructor(
    private readonly command: CommandDescription<never>,
    private readonly ctx: CommandActionContext,
    start: GuidedPanelStart,
    private readonly resolve: (result: PanelResult) => void,
  ) {
    this.startedInForm = start.action !== undefined;
    this.place = start.place;
    this.given = new Set(start.place?.given ?? []);
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
    this.stepIndex = Math.max(0, Math.min(step, stepsOf(action, this.given).length - 1));
    this.field = this.firstOpenField();
    this.note = '';
    // A blank of a list that opens holding a value (what is set now) reads as that row's name once the list is read.
    for (const input of action.inputs) {
      const list = listChoices(input);
      if (!list || !this.texts[input.id] || this.given.has(input.id)) continue;
      void listByName<CommandActionContext>(list.list).read(this.ctx, this.values(), new AbortController().signal)
        .then(() => this.ctx.renderRequest?.(), () => undefined);
    }
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
      if ('impliedBy' in input.typed && values[input.id] === undefined) values[input.id] = impliedValue(input.typed.impliedBy, values);
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
    // A fixed choice with a usual answer is passed over (the arrows change it); one that must be chosen is opened on.
    const index = this.stepFields().findIndex((input) => (!fixedChoices(input) || input.required === true) && !values[input.id] && !this.texts[input.id]);
    return Math.max(0, index);
  }

  private stepFields(): readonly InputDescription[] {
    const action = this.action;
    if (!action) return [];
    const step = stepsOf(action, this.given)[this.stepIndex] ?? 1;
    const values = this.values();
    return action.inputs.filter((input) => !this.given.has(input.id) && (input.step ?? 1) === step && isShown(input, values) && (!('impliedBy' in input.typed) || fixedChoices(input) !== undefined));
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
    if (row.action.blanksTypedOnly) { this.settle({ kind: 'run', action: row.action, values: defaultValues(row.action) }); return; }
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
      // The list opens on what is set now (a value the form opened on, else the input's default), not on its first row.
      const current = this.texts[input.id] || (input.required === true ? '' : input.required.default);
      open(`${this.action?.label ?? ''}  ›  ${input.label}`, items, {
        ...(current && items.some((item) => item.id === current) ? { preSelectId: current } : {}),
        allowSearch: true,
        primaryVerbLabel: 'Choose',
        ...(list.allowOther ? { customItem: (query: string) => query ? { id: query, label: `Use "${query}"`, detail: list.allowOther!.reason } : null } : {}),
      }, (result) => {
        this.picking = false;
        if (result) { this.texts[input.id] = result.item.id; this.field = Math.min(this.field + 1, this.stepFields().length - 1); }
        this.ctx.renderRequest?.();
      });
    }, () => { this.picking = false; this.note = `Could not read the choices for ${input.label}; type one instead.`; this.noteFor = input.id; this.ctx.renderRequest?.(); });
  }

  private advance(): void {
    const fields = this.stepFields();
    const current = fields[this.field];
    if (current && listChoices(current) && !this.texts[current.id]) { this.pick(current); return; }
    const missing = this.missingInStep();
    // The empty blank is named under that blank (renderForm), with nothing else said about it.
    if (missing) { this.note = `${missing.label} is needed.`; this.noteFor = missing.id; this.field = Math.max(0, fields.indexOf(missing)); return; }
    const action = this.action!;
    if (this.stepIndex < stepsOf(action, this.given).length - 1) { this.stepIndex += 1; this.field = this.firstOpenField(); this.note = ''; return; }
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
      // The command's one-key choice on the selected row ("s skip for now").
      const rowKey = this.rowKeyLabel();
      if (rowKey && token.type === 'text' && token.value === this.command.rowKey!.key) {
        const action = rows[this.selected]?.action;
        if (action) {
          (this.command.rowKey!.press as (id: string, ctx: CommandActionContext) => void)(action.id, this.ctx);
          this.readRowValues(rows);
        }
        return;
      }
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
      this.noteFor = undefined;
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'tab' || key === 'down') this.field = (this.field + 1) % Math.max(1, fields.length);
    else if (key === 'up') this.field = (this.field - 1 + fields.length) % Math.max(1, fields.length);
    else if ((key === 'left' || key === 'right') && input && fixedChoices(input)) this.cycle(input, key === 'left' ? -1 : 1);
    // A blank chosen from a list that already holds a value (one the form opened on): ⏎ keeps it, → opens the list on it.
    else if (key === 'right' && input && listChoices(input)) this.pick(input);
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
      title: this.place ? this.place.title : `/${this.command.name}`,
      ...(sub ? { sub } : {}),
      titleGlyph: { char: '', fg: t.text },
      hints,
      height: rows + 6 + (hints.length > 0 ? 2 : 0),
      center: true,
    });
  }

  /** The selected row's one-key choice, as the hint names it; undefined when it has none. */
  private rowKeyLabel(): string | undefined {
    const rowKey = this.command.rowKey;
    const action = this.rows()[this.selected]?.action;
    if (!rowKey || !action) return undefined;
    return (rowKey.label as (id: string, ctx: CommandActionContext) => string | undefined)(action.id, this.ctx);
  }

  private renderMenu(screenWidth: number, screenHeight: number): SurfaceLayer {
    const rows = this.rows();
    const rowKey = this.rowKeyLabel();
    const hints: KitHint[] = [['↑↓', 'move'], ['⏎', 'choose'], ...(rowKey ? [[this.command.rowKey!.key, rowKey] as KitHint] : [])];
    const f = this.frame(screenWidth, screenHeight, rows.length, hints, this.group ? this.group.label : this.command.summary);
    // The kit list: the product's selection bar, starting at the title's column.
    const kitRows: KitRow[] = rows.map((row, index) => {
      const value = row.action ? (this.rowValues.get(row.action.id) ?? (row.action.risk !== 'none' ? riskWords(row.action.risk) : '')) : '';
      return { label: rowLabel(row), ...(value ? { right: value } : {}), selected: index === this.selected };
    });
    // drawList paints the bar MODAL_MARK_INSET columns out from the text on each side: the bar spans title column to esc's edge.
    const listed = drawList(f.canvas, { mouseNavigation: true, rows: kitRows, top: f.top, bottom: f.bottom, x0: f.l + 1 + MODAL_MARK_INSET, x1: f.r - MODAL_MARK_INSET, scrollKey: { owner: this, name: 'guided-menu' } });
    f.hintRight = scrollCountText(listed.above, listed.below);
    return finishModal(f);
  }

  private renderForm(screenWidth: number, screenHeight: number): SurfaceLayer {
    const t = activeTokens();
    const action = this.action!;
    const steps = stepsOf(action, this.given);
    const fields = this.stepFields();
    const values = this.values();
    const line = renderTypedLine(this.command, action.id, withoutSecrets(action, values));
    const lastStep = this.stepIndex >= steps.length - 1;
    // On the last step Enter submits: its key says what it does, and what submitting does is said above the line
    // (with a place's item named as the place names it, never by its id).
    const said = this.place?.display ? { ...values, ...this.place.display } : values;
    const consequence = lastStep ? wrapLines(actionConsequence(action, said), Math.max(20, standardModalWidth(screenWidth) - 12)) : [];
    const f = this.frame(screenWidth, screenHeight, fields.length * 2 + 6 + (consequence.length > 0 ? consequence.length + 1 : 0),
      [['⏎', lastStep ? actionSubmitLabel(action, values) : 'next'], ['tab', 'field'], ['esc', 'back']]);
    // Text starts at the title's column; the form scrolls so the blank being answered is always shown.
    const l = f.l + 1;
    const width = f.r - l + 1;
    let y = f.top;
    // A place's form is titled with the action's label already: under it, only the step, when there are several.
    const labelled = this.place?.title === action.label;
    if (!labelled || steps.length > 1) {
      f.canvas.put(l, y, labelled ? `Step ${this.stepIndex + 1} of ${steps.length}` : `${action.label}${steps.length > 1 ? ` · step ${this.stepIndex + 1} of ${steps.length}` : ''}`, { fg: t.textMuted });
      y += 1;
    }
    const question = action.stepTitles?.[this.stepIndex];
    if (question) { f.canvas.put(l, y, `   ${question}`, { fg: t.text }); y += 1; }
    const labelWidth = Math.min(22, Math.max(...fields.map((input) => input.label.length)) + 3);
    const inline = (input: InputDescription): boolean => {
      const choices = fixedChoices(input);
      return choices !== undefined && choices.length <= 3 && choices.reduce((sum, choice) => sum + choice.label.length + 5, 0) < width - 4;
    };
    // A fixed choice whose answers carry a sentence keeps one row under it for the chosen answer's sentence.
    const described = (input: InputDescription): boolean => fixedChoices(input)?.some((choice) => Boolean(choice.help)) === true;
    const heightOf = (index: number, first: number): number =>
      (inline(fields[index]!) ? 3 : index === first || inline(fields[index - 1]!) ? 2 : 1) + (described(fields[index]!) ? 2 : 0);
    // The chosen answer's sentence, on up to two rows under it (cut with "…" past them).
    const sentenceUnder = (input: InputDescription, x: number): void => {
      if (!described(input)) return;
      const chosen = fixedChoices(input)?.find((choice) => choice.value === this.texts[input.id]);
      const room = Math.max(10, f.r - x - 1);
      const rows: string[] = [];
      let row = '';
      for (const word of (chosen?.help ?? '').split(/\s+/).filter(Boolean)) {
        if (row && row.length + 1 + word.length > room) { rows.push(row); row = word; } else row = row ? `${row} ${word}` : word;
      }
      if (row) rows.push(row);
      const shown = rows.slice(0, 2);
      if (rows.length > 2) shown[1] = `${shown[1]!.slice(0, room - 1)}…`;
      for (let k = 0; k < 2; k++) {
        y += 1;
        if (shown[k]) f.canvas.put(x, y, shown[k]!, { fg: t.textMuted });
      }
    };
    // Rows left for blanks: the run line and its gap (and a note) stay at the bottom.
    const room = f.bottom - y - 2 - (this.note ? 2 : 0) - (consequence.length > 0 ? consequence.length + 1 : 0);
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
        // What the chosen answer means, under the answers (each answer's own sentence as the arrows move).
        sentenceUnder(input, l + 4);
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
        // The chosen answer's sentence under it, as the arrows move from one answer to the next.
        sentenceUnder(input, l + label.length);
      } else if (typed !== '') {
        // A value picked from a list reads as its label; the id is what is sent.
        const shown = input.kind === 'secret' && input.plainWhen?.(values) !== true ? '•'.repeat(Math.min(typed.length, 24)) : valuesAsShown([input], { [input.id]: typed })[input.id] ?? typed;
        x = f.canvas.put(x, y, shown.slice(-(f.r - x - 2)), { fg: t.brand });
        if (focused) f.canvas.put(x, y, '▏', { fg: t.textMuted });
        if (focused && listChoices(input)) f.canvas.put(x + 2, y, '→ to change', { fg: t.textFaint });
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
      // A blank left empty is named right under it.
      if (this.note && this.noteFor === input.id) { f.canvas.put(l + labelWidth + 3, y, this.note, { fg: t.warning }); y += 1; }
    }
    if (last < fields.length - 1) { y += 1; f.canvas.put(l + 3, y, `↓ ${fields.length - 1 - last} more below (tab)`, { fg: t.textFaint }); }
    if (this.note && (this.noteFor === undefined || !fields.slice(first, last + 1).some((input) => input.id === this.noteFor))) { y += 1; f.canvas.put(l + 3, y, this.note, { fg: t.warning }); }
    let consequenceY = y + 2;
    for (const row of consequence) {
      if (consequenceY >= f.bottom - 1) break;
      f.canvas.put(l + 3, consequenceY, row, { fg: t.text });
      consequenceY += 1;
    }
    // A place's form says what submitting does and shows no command line.
    if (this.place) return finishModal(f);
    const runY = Math.min(f.bottom, consequence.length > 0 ? consequenceY + 1 : y + 2);
    const lead = '   This will run: ';
    f.canvas.put(l, runY, lead, { fg: t.textMuted });
    f.canvas.put(l + lead.length, runY, line.length > width - lead.length ? `${line.slice(0, width - lead.length - 1)}…` : line, { fg: t.text });
    return finishModal(f);
  }
}

/** Where the panel starts: a form for one action (with values and a step), or the first screen. */
export interface GuidedPanelStart {
  readonly action?: ActionDescription<never> | undefined;
  readonly values?: ActionValues | undefined;
  readonly step?: number | undefined;
  /**
   * Opened from a place (places/place-modal.ts): its title heads the form, and no command line is shown;
   * `given` are the inputs the place filled from its selected item (kept, not asked), `display` how the
   * form's sentence names them (the item's title in place of its id).
   */
  readonly place?: {
    readonly title: string;
    readonly given?: readonly string[] | undefined;
    readonly display?: ActionValues | undefined;
  } | undefined;
}

/** Open the guided panel and resolve what the person chose (an action and its values) or that they left. */
export function openGuidedPanel(
  command: CommandDescription<never>,
  ctx: CommandActionContext,
  start: GuidedPanelStart = {},
): Promise<PanelResult> | undefined {
  const push = ctx.pushSurfaceModal;
  if (!push) return undefined;
  return new Promise((resolve) => push(new GuidedPanel(command, ctx, start, resolve)));
}
