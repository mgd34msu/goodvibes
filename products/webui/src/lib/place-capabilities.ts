/**
 * place-capabilities.ts, a place's actions as the browser runs them.
 *
 * A place names each action by its capability id only (place-types.ts). The
 * browser reads what a capability is and where it runs from the daemon it
 * talks to, at run time: `capabilities.list` answers every capability of the
 * daemon's own registry (its words: label, sentence, done line, risk, what
 * undoes it, its inputs; where it runs), read once per tab and again when it
 * could not be read. Nothing here depends on a generated file, so a capability
 * moved into the daemon has its button as soon as that daemon runs it. It runs
 * one through `capabilities.run` with the person's claim (a pressed button or
 * a submitted form is the request), so it is never put to them again.
 *
 * A capability that runs only where a conversation is, or only inside a
 * terminal program for now, is not a control here: the place shows the actions
 * the daemon can run.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  actionButton, actionDoneLine, actionSentence, effectiveRisk, isShown, riskSentences, riskWords, withoutSecrets,
  type ActionRisk, type ActionShape, type ActionValues, type InputDescription,
} from '@goodvibes/engine/terminal-shell/command-actions/data';
import type { ActionData, CommandActionsData, InputData } from './command-actions-types';
import { invokeOwnerMethod } from './goodvibes';

export interface PlaceCapability {
  readonly id: string;
  /** Where it runs, as the daemon says: here (`daemon`), where a conversation is (`session`), or a terminal for now. */
  readonly runsIn: 'daemon' | 'session' | 'terminal';
  readonly command: Pick<CommandActionsData, 'name' | 'title'>;
  readonly action: ActionData;
  readonly shape: ActionShape;
  /** The daemon runs it, so the browser can. */
  readonly runsOnDaemon: boolean;
  /** Its function group (capabilities/groups.ts). */
  readonly group: string;
}

/** Every capability the daemon knows, by id. */
export type CapabilityIndex = ReadonlyMap<string, PlaceCapability>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const record = (value: unknown): Readonly<Record<string, unknown>> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** One listed capability as the forms and sentences read it (the shape the action sheets draw). */
function capabilityOf(listed: Readonly<Record<string, unknown>>): PlaceCapability | undefined {
  const id = text(listed.id);
  if (!id) return undefined;
  const runsIn = text(listed.runsIn);
  const runsOnDaemon = runsIn === 'daemon';
  const lasts = typeof listed.lasts === 'string' || (listed.lasts && typeof listed.lasts === 'object') ? listed.lasts : 'not-a-change';
  const action = {
    id: text(listed.actionId) || id,
    label: text(listed.label) || id,
    word: text(listed.word),
    line: '',
    sentence: text(listed.sentence),
    done: text(listed.done),
    touches: (text(listed.touches) || 'this-machine') as ActionData['touches'],
    lasts,
    risk: text(listed.risk) || 'none',
    ...(text(listed.riskDone) ? { riskDone: text(listed.riskDone) } : {}),
    ...(listed.ownerOnly ? { ownerOnly: listed.ownerOnly } : {}),
    ...(text(listed.undoneBy) ? { undoneBy: text(listed.undoneBy) } : {}),
    ...(text(listed.button) ? { button: text(listed.button) } : {}),
    ...(Array.isArray(listed.stepTitles) ? { stepTitles: listed.stepTitles.map(text) } : {}),
    ...(listed.asksItself === true ? { asksItself: true } : {}),
    ...(listed.reveals ? { reveals: listed.reveals } : {}),
    // Runs through `capabilities.run` (an action sheet sends its blanks as that method's inputs); one that runs elsewhere says where.
    operator: runsOnDaemon
      ? {
        method: 'capabilities.run',
        fields: {
          id: `=${JSON.stringify(id)}`,
          ...Object.fromEntries((Array.isArray(listed.inputs) ? listed.inputs : []).map((input) => text(record(input).id)).filter(Boolean).map((input) => [`inputs.${input}`, input])),
        },
      }
      : { terminalOnly: runsIn === 'session' ? 'It acts on a conversation, so it is done in the terminal app or the Agent.' : 'It is done in the terminal app or the Agent for now.' },
    inputs: (Array.isArray(listed.inputs) ? listed.inputs : []).map(record) as unknown as readonly InputData[],
    capability: { id, group: text(listed.group), home: runsOnDaemon ? 'daemon' : 'session', repeat: text(listed.repeat) || 'unsafe' },
  } as unknown as ActionData;
  return {
    id, action, shape: action as unknown as ActionShape, runsOnDaemon, group: text(listed.group),
    runsIn: runsOnDaemon ? 'daemon' : runsIn === 'session' ? 'session' : 'terminal',
    command: { name: text(listed.command), title: text(listed.commandTitle) || text(listed.command) },
  };
}

let index: CapabilityIndex | null = null;
let loading: Promise<CapabilityIndex> | null = null;
const listeners = new Set<() => void>();

/** Read every capability from the daemon (once per tab; a read that failed is tried again by the next caller). */
export function loadCapabilities(): Promise<CapabilityIndex> {
  if (index) return Promise.resolve(index);
  loading ??= invokeOwnerMethod('capabilities.list', {}).then((output) => {
    const listed = Array.isArray(record(output).capabilities) ? record(output).capabilities as unknown[] : [];
    const next = new Map<string, PlaceCapability>();
    for (const entry of listed) {
      const capability = capabilityOf(record(entry));
      if (capability && !next.has(capability.id)) next.set(capability.id, capability);
    }
    index = next;
    for (const listener of [...listeners]) listener();
    return next;
  }, (error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The daemon's capabilities, or null until read; with `load`, this mount asks for them. */
export function useCapabilityIndex(load = true): CapabilityIndex | null {
  const current = useSyncExternalStore(subscribe, () => index, () => index);
  useEffect(() => {
    if (load && !current) void loadCapabilities().catch(() => undefined);
  }, [load, current]);
  return current;
}

/** The daemon's capabilities as read so far (null until read). */
export function currentCapabilities(): CapabilityIndex | null {
  return index;
}

/** A capability as the daemon describes it, by the command and action it names (an action sheet's lookup). */
export function capabilityByAction(capabilities: CapabilityIndex | null, command: string, actionId: string): PlaceCapability | undefined {
  if (!capabilities) return undefined;
  for (const capability of capabilities.values()) {
    if (capability.command.name === command && capability.action.id === actionId) return capability;
  }
  return undefined;
}

/** A capability by id, as the daemon describes it; undefined when it does not know it. */
export function resolvePlaceCapability(capabilities: CapabilityIndex | null | undefined, id: string): PlaceCapability | undefined {
  return capabilities?.get(id);
}

/** Every capability the daemon can run (the command palette's list). */
export function daemonCapabilities(capabilities: CapabilityIndex): readonly PlaceCapability[] {
  return [...capabilities.values()].filter((capability) => capability.runsOnDaemon);
}

/** The input values as a person reads them: a secret's value never, an item's id as its title. */
export function displayValues(capability: PlaceCapability, values: ActionValues, names: Readonly<Record<string, string>>): ActionValues {
  const safe = withoutSecrets(capability.shape, values);
  return Object.fromEntries(Object.entries(safe).map(([input, value]) => [input, names[value] ?? value]));
}

export function capabilitySentence(capability: PlaceCapability, shown: ActionValues): string {
  return actionSentence(capability.shape, shown);
}

export function capabilityButton(capability: PlaceCapability): string {
  return actionButton(capability.shape);
}

export function capabilityRisk(capability: PlaceCapability, values: ActionValues): ActionRisk {
  return effectiveRisk(capability.shape, values);
}

export function capabilityRiskWords(risk: ActionRisk): string {
  return riskWords(risk);
}

/** Each risk in force as its own sentence ("This loosens a protection. This cannot be undone."), as the terminal asks. */
export function capabilityRiskSentences(capability: PlaceCapability, values: ActionValues): string {
  return riskSentences(capability.shape, values);
}

/** Ask first only for a capability that cannot be undone or weakens a protection, and never for an answer to the waiting item. */
export function asksFirst(capability: PlaceCapability, values: ActionValues, answersTheItem: boolean): ActionRisk | undefined {
  if (answersTheItem) return undefined;
  if ((capability.action as { readonly asksItself?: unknown }).asksItself === true) return undefined;
  const risk = capabilityRisk(capability, values);
  return risk === 'cannot-be-undone' || risk === 'loosens-a-protection' ? risk : undefined;
}

/** A value the person must see once (a capability that `reveals`): a one-time token, a join key. */
export interface CapabilityReveal {
  readonly label: string;
  readonly note: string;
  readonly value: string;
  readonly qr?: string | undefined;
}

export interface CapabilityAnswer {
  readonly text: string;
  readonly detail?: string | undefined;
  /** Shown whole in its own pane until the person leaves it; never put in the outcome line, a notice or anything kept. */
  readonly reveal?: CapabilityReveal | undefined;
}

function answerOf(output: unknown): CapabilityAnswer {
  const record = output && typeof output === 'object' && !Array.isArray(output) ? output as Record<string, unknown> : {};
  const reveal = record.reveal && typeof record.reveal === 'object' ? record.reveal as Record<string, unknown> : undefined;
  return {
    text: typeof record.text === 'string' ? record.text : '',
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    ...(reveal && typeof reveal.value === 'string' ? {
      reveal: {
        label: typeof reveal.label === 'string' ? reveal.label : 'Shown once',
        note: typeof reveal.note === 'string' ? reveal.note : '',
        value: reveal.value,
        ...(typeof reveal.qr === 'string' ? { qr: reveal.qr } : {}),
      },
    } : {}),
  };
}

/**
 * An input supplied from context: `program`, the terminal program asking (`CapabilityCaller.program`, the same name
 * `capabilities.run` takes; system-settings.ts `PROGRAM_INPUT`). A terminal program fills it with its own name; the
 * browser is neither program, so the person names it, with no default, and the form will not run without it.
 */
export function namedByCaller(input: { readonly id: string }): boolean {
  return input.id === 'program';
}

/**
 * Whether the browser's form shows an input: as every form decides (`isShown`), except that one the terminal program
 * asking supplies (`showWhen.suppliedBy`) and the browser must name itself (`namedByCaller`) is shown here.
 */
export function shownInBrowser(input: { readonly id: string; readonly showWhen?: unknown }, values: ActionValues): boolean {
  const showWhen = input.showWhen as { readonly suppliedBy?: unknown } | undefined;
  if (namedByCaller(input) && showWhen && typeof showWhen === 'object' && 'suppliedBy' in showWhen) return true;
  return isShown(input as unknown as InputDescription, values);
}

/** Whether an action always opens its form (`form: true`), else only when a required input is left. */
export function opensForm(capability: PlaceCapability, values: ActionValues, always: boolean): boolean {
  if (always) return true;
  if (capability.action.inputs.some((input) => namedByCaller(input) && !values[input.id])) return true;
  return capability.action.inputs.some((input) => input.required === true && values[input.id] === undefined
    && isShown(input as unknown as InputDescription, values) && !('impliedBy' in input.typed));
}

/**
 * Run a capability as the person's own request (`capabilities.run` with their claim), for the project they chose (its
 * caller's folder, `workingDirectory`). Throws the daemon's refusal.
 */
export async function runPlaceCapability(id: string, values: ActionValues, project?: string | undefined): Promise<CapabilityAnswer> {
  // "Every project" names no project (an act on one project's things then asks for one).
  return answerOf(await invokeOwnerMethod('capabilities.run', { id, inputs: values, ...(project && project.startsWith('/') ? { workingDirectory: project } : {}) }));
}

/**
 * The line after an action, as the terminal's place says it: the done line with the item named by its title, then
 * up to two of the capability's own lines (the item's id, or a short form of it, becomes its title; a line naming
 * another record by a long id says nothing a person reads), an answer named as the person pressed it ("No"), each
 * line a sentence.
 */
export function outcomeLine(
  capability: PlaceCapability,
  values: ActionValues,
  shown: ActionValues,
  answer: CapabilityAnswer,
  item: { readonly id: string; readonly title: string } | undefined,
  pressed?: { readonly said: string; readonly values: ActionValues } | undefined,
): string {
  const done = actionDoneLine(capability.shape, shown);
  const plainDone = actionDoneLine(capability.shape, withoutSecrets(capability.shape, values));
  const title = item ? `"${item.title}"` : '';
  const named = (word: string): boolean => item !== undefined && (word === item.id || (word.length >= 8 && item.id.startsWith(word)));
  const sent = pressed ? Object.values(pressed.values).filter((value) => value !== '' && value !== pressed.said) : [];
  const asPressed = (line: string): string => sent.reduce((current, value) => current.replace(`: ${value}`, `: ${pressed!.said}`), line);
  const own = (answer.detail ?? answer.text).split('\n').map((line) => line.trim()).filter(Boolean);
  const rest = own
    .filter((line) => line !== plainDone && line !== done)
    .map(asPressed)
    .map((line) => (item ? line.replace(/[\w-]+/g, (word) => (named(word) ? title : word)) : line))
    .filter((line) => !/\S{28,}/.test(line));
  const sentence = (line: string): string => (/[.!?:)"]$/.test(line.trimEnd()) ? line.trimEnd() : `${line.trimEnd()}.`);
  return [done || rest.shift() || 'Done.', ...rest.slice(0, 2)].map(sentence).join(' ');
}
