/**
 * Named live lists: "the MCP servers you have", "the tools a server offers".
 * Each is declared once, in the file of the command that owns the data, with
 * the terminal reader and the operator method that returns the same rows to
 * the web UI. A list is read only when a guided step or a completion dropdown
 * asks for it; nothing reads it at start-up or on a turn.
 */
import type { ListName } from './types.js';

export interface ListRow {
  readonly value: string;
  readonly label: string;
  readonly detail?: string | undefined;
  /** A short state word shown on the right ("blocked, kept"). */
  readonly state?: string | undefined;
}

/**
 * How the web UI turns an operator method's answer into rows, as data (it is
 * written to the generated command-actions file): the array at `from` (a dot
 * path), kept where `where.field` equals `where.equals` (`{input}` blanks are
 * the earlier answers), each entry's `each` array taken instead when given,
 * and each row's fields read from the named properties (`.` is the entry itself).
 */
export interface ListRowsFromOutput {
  readonly from: string;
  readonly where?: { readonly field: string; readonly equals: string } | undefined;
  readonly each?: string | undefined;
  readonly value: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly state?: string | undefined;
}

export interface NamedList<Ctx> {
  readonly name: string;
  readonly read: (ctx: Ctx, earlier: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<readonly ListRow[]>;
  readonly operator:
    | {
        readonly method: string;
        /** The method's input; `{input}` blanks in a value are the earlier answers. */
        readonly input: Readonly<Record<string, string>>;
        readonly rows: ListRowsFromOutput;
      }
    | { readonly terminalOnly: string };
}

function readPath(value: unknown, path: string): unknown {
  if (path === '.' || path === '') return value;
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Readonly<Record<string, unknown>>)[part];
  }
  return current;
}

function fillBlanks(template: string, earlier: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_whole, id: string) => earlier[id] ?? '');
}

/** The rows an operator method's answer holds, read by the list's declared shape (the web UI reads them the same way). */
export function rowsFromOutput(spec: ListRowsFromOutput, output: unknown, earlier: Readonly<Record<string, string>>): readonly ListRow[] {
  const list = readPath(output, spec.from);
  if (!Array.isArray(list)) return [];
  const kept = spec.where ? list.filter((entry) => String(readPath(entry, spec.where!.field)) === fillBlanks(spec.where!.equals, earlier)) : list;
  const entries = spec.each ? kept.flatMap((entry) => { const inner = readPath(entry, spec.each!); return Array.isArray(inner) ? inner : []; }) : kept;
  const seen = new Set<string>();
  // One row per value: a shop bought from twice is one shop.
  return entries.map((entry): ListRow => {
    const text = (path: string | undefined): string | undefined => {
      if (path === undefined) return undefined;
      const value = readPath(entry, path);
      return value === undefined || value === null ? undefined : String(value);
    };
    return {
      value: text(spec.value) ?? '',
      label: text(spec.label) ?? text(spec.value) ?? '',
      ...(text(spec.detail) !== undefined ? { detail: text(spec.detail) } : {}),
      ...(text(spec.state) !== undefined ? { state: text(spec.state) } : {}),
    };
  }).filter((row) => !seen.has(row.value) && seen.add(row.value) !== undefined);
}

/** The input an operator method is called with for a list, its blanks filled. */
export function listOperatorInput(input: Readonly<Record<string, string>>, earlier: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, fillBlanks(value, earlier)]));
}

const lists = new Map<string, NamedList<never>>();

/**
 * Register a list under its name and return the name to put in an input's
 * `choices`. A second registration of the same name with a different reader
 * is a programming error and throws, so two commands cannot shadow each other.
 */
export function defineList<Ctx>(list: NamedList<Ctx>): ListName {
  const existing = lists.get(list.name);
  if (existing && existing !== (list as unknown as NamedList<never>)) {
    throw new Error(`The live list "${list.name}" is defined twice; one list has one owner.`);
  }
  lists.set(list.name, list as unknown as NamedList<never>);
  return list.name as ListName;
}

/**
 * The label of each value a list showed, by list: a value picked from a list (an id such as "qm-1") is shown by its
 * label wherever a person reads it (the form, the question before it runs, the outcome); the id is what is sent.
 * Kept as the lists are read; the newest read of a list wins.
 */
const pickedLabels = new Map<string, Map<string, string>>();
const PICKED_LABELS_PER_LIST = 500;

function rememberLabels(name: string, rows: readonly ListRow[]): void {
  const labels = new Map<string, string>();
  for (const row of rows.slice(0, PICKED_LABELS_PER_LIST)) if (row.label && row.label !== row.value) labels.set(row.value, row.label);
  pickedLabels.set(name, labels);
}

/** A value of a list as a person reads it: its label when the list showed one, else the value itself. */
export function pickedLabel(name: ListName | string, value: string): string {
  return pickedLabels.get(name)?.get(value) ?? value;
}

/** The list registered under a name; throws for a name no command defined. Its reads keep the labels they show. */
export function listByName<Ctx = unknown>(name: ListName | string): NamedList<Ctx> {
  const list = lists.get(name) as unknown as NamedList<Ctx> | undefined;
  if (!list) throw new Error(`No live list named "${name}" is defined.`);
  return {
    ...list,
    read: async (ctx, earlier, signal) => {
      const rows = await list.read(ctx, earlier, signal);
      rememberLabels(list.name, rows);
      return rows;
    },
  };
}

/** Every defined list, for the generators and the check. */
export function allLists(): readonly NamedList<unknown>[] {
  return [...lists.values()] as unknown as readonly NamedList<unknown>[];
}

/** Read a list's rows with the earlier answers it depends on. */
export async function readList<Ctx>(name: ListName, ctx: Ctx, earlier: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<readonly ListRow[]> {
  return listByName<Ctx>(name).read(ctx, earlier, signal ?? new AbortController().signal);
}

/**
 * Every value picked from a list shown by its label: a live list's (ActionShape inputs with list choices) and a fixed
 * list's (`{ value, label }` choices), each of several picked too; other values as they are.
 */
export function valuesAsShown(inputs: ReadonlyArray<{ readonly id: string; readonly choices?: unknown }>, values: Readonly<Record<string, string>>): Record<string, string> {
  const shown: Record<string, string> = { ...values };
  for (const input of inputs) {
    const value = values[input.id];
    if (value === undefined) continue;
    if (Array.isArray(input.choices)) {
      const fixed = new Map((input.choices as ReadonlyArray<{ readonly value?: unknown; readonly label?: unknown }>)
        .filter((choice) => typeof choice?.value === 'string' && typeof choice.label === 'string')
        .map((choice) => [choice.value as string, choice.label as string]));
      shown[input.id] = fixed.get(value) ?? value.split(',').map((part) => fixed.get(part.trim()) ?? part.trim()).join(', ');
      if (!fixed.has(value) && !value.split(',').some((part) => fixed.has(part.trim()))) shown[input.id] = value;
      continue;
    }
    const choices = input.choices as { readonly list?: string } | undefined;
    if (!choices || typeof choices.list !== 'string') continue;
    // A value picked whole, else each of several picked ("a,b": a list input that takes more than one).
    const whole = pickedLabel(choices.list, value);
    shown[input.id] = whole !== value ? whole : value.split(',').map((part) => pickedLabel(choices.list!, part.trim())).join(', ');
  }
  return shown;
}
