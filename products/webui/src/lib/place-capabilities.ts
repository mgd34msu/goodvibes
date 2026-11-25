/**
 * place-capabilities.ts, a place's actions as the browser runs them.
 *
 * A place names each action by its capability id only (place-types.ts). The
 * browser reads the capability's words (label, inputs, sentence, done line,
 * risk, what undoes it) from the generated command actions
 * (lib/generated/command-actions.ts, the engine's command-actions.json: every
 * described action, and in `capabilities` every moved capability no command
 * carries, with its declaration), by the same rule the terminal resolves it with: the declared
 * `capability.id`, else `capabilityIdOf(command, word, group)`. It runs one
 * through `capabilities.run` with the person's claim (a pressed button or a
 * submitted form is the request), so it is never put to them again.
 *
 * A capability that runs only where a conversation is, or only inside a
 * terminal program for now, is not a control here: the place shows the actions
 * the daemon can run.
 */
import { capabilityGroupOf, capabilityIdOf } from '@goodvibes/engine/platform/platform/capabilities/words';
import {
  actionButton, actionDoneLine, actionSentence, effectiveRisk, isShown, riskWords, withoutSecrets,
  type ActionRisk, type ActionShape, type ActionValues, type InputDescription,
} from '@goodvibes/engine/terminal-shell/command-actions/data';
import { asActionShape, type ActionData, type CommandActionsData, type CommandActionsSnapshot } from './command-actions-types';
import { invokeOwnerMethod } from './goodvibes';

export interface PlaceCapability {
  readonly id: string;
  readonly command: CommandActionsData;
  readonly action: ActionData;
  readonly shape: ActionShape;
  /** The daemon runs it, so the browser can. */
  readonly runsOnDaemon: boolean;
}

const indexes = new WeakMap<CommandActionsSnapshot, ReadonlyMap<string, PlaceCapability>>();

function indexOf(snapshot: CommandActionsSnapshot): ReadonlyMap<string, PlaceCapability> {
  const held = indexes.get(snapshot);
  if (held) return held;
  const index = new Map<string, PlaceCapability>();
  // The typed commands' actions, then the capabilities no slash command carries (each by the command it names).
  for (const command of [...snapshot.commands, ...(snapshot.capabilities ?? [])]) {
    for (const action of command.actions) {
      const id = action.capability?.id ?? capabilityIdOf(command.name, action.word, capabilityGroupOf(command.name, action.id));
      // A capability a command carries wins over the same id added as commandless (the generator adds each once).
      if (index.has(id)) continue;
      const runsOnDaemon = action.capability ? action.capability.home === 'daemon' : 'method' in action.operator;
      index.set(id, { id, command, action, shape: asActionShape(action), runsOnDaemon });
    }
  }
  indexes.set(snapshot, index);
  return index;
}

/** A capability by id, from the generated command actions; undefined when they do not hold it. */
export function resolvePlaceCapability(snapshot: CommandActionsSnapshot | null | undefined, id: string): PlaceCapability | undefined {
  return snapshot ? indexOf(snapshot).get(id) : undefined;
}

/** Every capability the daemon can run, as the generated command actions hold them (the command palette's list). */
export function daemonCapabilities(snapshot: CommandActionsSnapshot): readonly PlaceCapability[] {
  return [...indexOf(snapshot).values()].filter((capability) => capability.runsOnDaemon);
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

/** Whether an action always opens its form (`form: true`), else only when a required input is left. */
export function opensForm(capability: PlaceCapability, values: ActionValues, always: boolean): boolean {
  if (always) return true;
  // An input the asking program supplies (`fromContext: 'program'`) is named by the person in the browser.
  if (capability.action.inputs.some((input) => (input as { readonly fromContext?: unknown }).fromContext === 'program' && values[input.id] === undefined)) return true;
  return capability.action.inputs.some((input) => input.required === true && values[input.id] === undefined
    && isShown(input as unknown as InputDescription, values) && !('impliedBy' in input.typed));
}

/** Run a capability as the person's own request (`capabilities.run` with their claim). Throws the daemon's refusal. */
export async function runPlaceCapability(id: string, values: ActionValues): Promise<CapabilityAnswer> {
  return answerOf(await invokeOwnerMethod('capabilities.run', { id, inputs: values }));
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
