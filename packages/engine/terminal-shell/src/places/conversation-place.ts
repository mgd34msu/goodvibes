/**
 * conversation-place.ts, This conversation: the controls on the conversation
 * itself, not a separate screen of things. The menu row opens a short list of
 * those controls, each with what it acts on as it is now (the title, how many
 * messages, how hard the model thinks, what waits in the queue or the
 * prompt), the key that reaches it where the conversation has one, and Enter
 * runs the selected one: at once when it needs nothing, else through the form
 * built from its inputs. Each control is a capability: most run where the
 * conversation is (capabilities/builtin/conversation.ts and
 * conversation-controls.ts), the context window size is the daemon's
 * (context-windows.ts, for the model this conversation uses); the model's
 * capability_run reaches the same ones. A control this program does not have
 * (the Agent queues no messages and keeps no guidance) or refuses by its own
 * policy (the Agent keeps no branches: `programs`) is not listed. The list is
 * read when the place opens and again after every control run, by itself.
 *
 * Every control is also an entry of the key table with no key of its own: in
 * this place's context (pressed here, it runs that control whichever row is
 * selected) and in the context `place.conversation-composer`, read while
 * writing a message (pressed there, it runs the control and says what happened
 * in the conversation). A person binds either in the Keys place.
 */
import {
  CONTEXT_WINDOW_CAPABILITIES, CONVERSATION_CLEAR, CONVERSATION_COMPACT, CONVERSATION_CONTROLS, CONVERSATION_UNDO, RISK_WORDS,
  type CapabilityDefinition,
} from '@goodvibes/engine/platform/platform/capabilities';
import type { SessionCapabilityServices } from '../agent-turn/capability-tools.js';
import type { KeyContext } from '../keybindings.js';
import { actionButton, actionDoneLine, actionSentence, effectiveRisk, isShown, riskSentences } from '../command-actions/typed-line.js';
import type { ActionValues } from '../command-actions/types.js';
import type { PlaceHost, PlaceKeyTable, PlaceProgramSource } from './place-host.js';
import { definePlace, type PlaceAction, type PlaceCapabilityAction, type PlaceItem, type PlaceList, type PlaceProgramName } from './place-types.js';
import { PINNED_LINES_ACTIONS, PINNED_LINES_LIST } from './pinned-lines-entries.js';

interface ControlItem extends PlaceItem {
  /** The capability's id: each control's action is shown on its own row only. */
  readonly state: string;
  readonly label: string;
  readonly sentence: string;
  /** What the control acts on, as it is now; empty when there is nothing short to say. */
  readonly now: string;
  /** The program's own key for it, as bound; empty when it has none. */
  readonly key: string;
  /** The line a person can still type for it (the commands that stay typed); empty when none. */
  readonly typed: string;
  readonly risk: string;
  readonly asks: string;
}

interface Control {
  readonly definition: CapabilityDefinition<never>;
  readonly command: string;
  /** The programs that have it (place-types.ts `programs`); absent: every program whose services have its piece. */
  readonly programs?: readonly PlaceProgramName[] | undefined;
}

const control = (definition: unknown, command: string, programs?: readonly PlaceProgramName[]): Control =>
  ({ definition: definition as CapabilityDefinition<never>, command, ...(programs ? { programs } : {}) });

/** Every control on the conversation, in the order the list shows them: the turn first, then the rest. */
const CONTROLS: readonly Control[] = [
  ...CONVERSATION_CONTROLS.slice(0, 2).map(({ definition, command }) => control(definition, command.name)),
  control(CONVERSATION_UNDO, 'undo'),
  control(CONVERSATION_COMPACT, 'compact'),
  control(CONVERSATION_CLEAR, 'clear'),
  ...CONVERSATION_CONTROLS.slice(2).map(({ definition, command }) =>
    // The Agent keeps one line of conversation: branching it is refused there by its own policy, so it is no control there.
    control(definition, command.name, definition.capability.id === 'session.branch' ? ['tui'] : undefined)),
  // The context window size of the model this conversation uses: the daemon's, for every program.
  ...CONTEXT_WINDOW_CAPABILITIES.map((definition) => control(definition, 'context')),
];

/** The commands that stay typed (`/retry`, `/undo`, ...): their line is another way in, shown on their rows. */
const TYPED_COMMANDS = new Set(['retry', 'redo', 'undo', 'compact', 'clear', 'checkpoint']);

/** The program's own key that reaches a control from the conversation, by capability id (the key table's action). */
const PROGRAM_KEYS: Readonly<Record<string, string>> = { 'paste.clipboard': 'paste' };

/** A control's name in the key table (`conversation-retry`): in this place's context and in the composer's. */
function keyNameOf(entry: Control): string {
  return entry.definition.capability.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** What a control acts on as it is now, read from the conversation's services; never a slow read. */
async function nowOf(id: string, services: SessionCapabilityServices): Promise<string> {
  try {
    switch (id) {
      case 'conversation.title': return services.turns?.title() ? `"${services.turns.title()}"` : 'no title yet';
      case 'conversation.compact':
      case 'conversation.clear': return plural(services.conversation.messageCount(), 'message');
      case 'effort.show': {
        const said = await services.context?.effort();
        return said ? said.split('\n')[0]!.replace(/^Reasoning effort:?\s*/i, '').slice(0, 40) : '';
      }
      case 'queue.list': { const queued = services.queue?.list().length ?? 0; return queued === 0 ? 'none waiting' : `${queued} waiting`; }
      case 'paste.list': { const folded = services.composer?.pastes()?.size ?? 0; return folded === 0 ? 'none folded' : `${folded} folded`; }
      default: return '';
    }
  } catch {
    // What the row says is a courtesy: a control whose fact cannot be read is still listed and runs.
    return '';
  }
}

/** Whether this program has a control: its piece is in the program's services, and the program does not refuse it. */
function usableHere(entry: Control, services: SessionCapabilityServices, program: 'tui' | 'agent'): boolean {
  if (entry.programs && !entry.programs.includes(program)) return false;
  // A control on the hosted session this terminal joined (hosted.send-later) is listed only while one is joined.
  if (entry.definition.capability.id.startsWith('hosted.') && services.hostedJoin?.joined() !== true) return false;
  const available = entry.definition.available as ((services: SessionCapabilityServices) => boolean) | undefined;
  return !available || available(services);
}

/** The controls this program has, with what each acts on now. */
async function readControls(services: SessionCapabilityServices, keys: PlaceKeyTable, program: 'tui' | 'agent'): Promise<readonly ControlItem[]> {
  const usable = CONTROLS.filter((entry) => usableHere(entry, services, program));
  return Promise.all(usable.map(async ({ definition, command }): Promise<ControlItem> => {
    const id = definition.capability.id;
    const programKey = PROGRAM_KEYS[id];
    const bound = programKey ? keys.getComboLabel(programKey) : '';
    return {
      // The row's id is not a word of the control's answers (the place names an item by its title wherever its id
      // shows); its state is the capability's id, the one action that applies to it.
      id: `control:${id}`, state: id, label: definition.label,
      // The sentence's blanks are named by what fills them (<title>), as the form names them.
      sentence: definition.sentence.replace(/,?\s*\{lasts\}/g, '')
        .replace(/\{(\w+)\}/g, (_blank, input: string) => `<${(definition.inputs.find((candidate) => candidate.id === input)?.label ?? input).toLowerCase()}>`),
      now: await nowOf(id, services),
      key: bound && bound !== '(unbound)' ? bound : '',
      typed: TYPED_COMMANDS.has(command) ? `/${command}${definition.word ? ` ${definition.word}` : ''}` : '',
      risk: definition.risk === 'none' ? '' : RISK_WORDS[definition.risk],
      asks: definition.inputs.filter((input) => input.required === true).map((input) => input.label.toLowerCase()).join(', '),
    };
  }));
}

/** The source of the controls list: this program's conversation services, read when asked. */
export function conversationPlaceSources(services: (() => SessionCapabilityServices | undefined) | undefined, keys: PlaceKeyTable, program: 'tui' | 'agent'): Readonly<Record<string, PlaceProgramSource>> {
  return {
    'conversation-controls': {
      read: async () => {
        const live = services?.();
        if (!live) throw new Error('this program has no open conversation');
        return readControls(live, keys, program);
      },
      // The controls change when one runs (the place reads every list again after each) or when the place opens.
      subscribe: () => () => {},
    },
  };
}

/** Each control on its row: Enter runs it (its state is its id, so the action applies to its own row only). */
const ROW_ACTIONS: readonly PlaceCapabilityAction<ControlItem>[] = CONTROLS.map(({ definition, programs }) => ({
  key: 'enter', list: 'controls', states: [definition.capability.id], capability: definition.capability.id, label: definition.label.toLowerCase(),
  ...(programs ? { programs } : {}),
}));

/** Each control as a key of this place with no default (`key: ''`): bound in the Keys place, it runs that control here. */
const KEY_ACTIONS: readonly PlaceCapabilityAction<ControlItem>[] = CONTROLS.map((entry) => ({
  key: '', id: keyNameOf(entry), capability: entry.definition.capability.id, label: entry.definition.label.toLowerCase(),
  ...(entry.programs ? { programs: entry.programs } : {}),
}));

export const CONVERSATION_PLACE = definePlace<ControlItem>({
  id: 'conversation',
  group: 'conversation',
  title: 'This conversation',
  lists: [
    {
      id: 'controls',
      label: 'Controls',
      noun: 'the controls on this conversation',
      source: { kind: 'program', name: 'conversation-controls', items: (raw) => (Array.isArray(raw) ? raw as ControlItem[] : []) },
      empty: 'There is no open conversation to act on.',
      row: (item) => ({ title: item.label, ...(item.now || item.key ? { right: item.key ? (item.now ? `${item.now} · ${item.key}` : item.key) : item.now } : {}) }),
      detail: (item) => [
        { text: item.sentence },
        ...(item.now ? [{ label: 'Now', text: item.now }] : []),
        ...(item.asks ? [{ label: 'Asks for', text: item.asks }] : []),
        ...(item.key ? [{ label: 'Key in the conversation', text: item.key }] : []),
        ...(item.typed ? [{ label: 'Or type', text: item.typed, tone: 'muted' as const }] : []),
        ...(item.risk ? [{ text: `This ${item.risk}.`, tone: 'warning' as const }] : []),
      ],
    },
    // The lines pinned in this conversation (pinned-lines-entries.ts, memory-b's).
    PINNED_LINES_LIST as unknown as PlaceList<ControlItem>,
  ],
  actions: [...ROW_ACTIONS, ...KEY_ACTIONS, ...(PINNED_LINES_ACTIONS as unknown as readonly PlaceAction<ControlItem>[])],
});

// ---------------------------------------------------------------------------
// The controls as keys read while writing a message
// ---------------------------------------------------------------------------

/** The key context of the controls read in the composer (`place.conversation-composer.<control>` in keybindings.json). */
export const CONVERSATION_COMPOSER_KEYS = 'place.conversation-composer';

/** Every control as an entry of the composer's context, with no default key: a person binds the ones he wants. */
export function conversationComposerKeyContext(): KeyContext {
  return {
    id: CONVERSATION_COMPOSER_KEYS,
    title: 'This conversation, while writing a message',
    global: true,
    actions: CONTROLS.map((entry) => ({ name: keyNameOf(entry), description: entry.definition.label.toLowerCase(), defaults: [] })),
  };
}

/**
 * Run a control from its key in the composer, as its row's Enter would: the form for what it needs, the one question
 * a control that cannot be undone asks (unless it asks itself), then the outcome said in the conversation (`say`).
 * `action` is the key table's entry (`place.conversation-composer.conversation-retry`).
 */
export async function runConversationControlKey(host: PlaceHost, action: string, say: (line: string) => void, program: 'tui' | 'agent'): Promise<void> {
  const name = action.startsWith(`${CONVERSATION_COMPOSER_KEYS}.`) ? action.slice(CONVERSATION_COMPOSER_KEYS.length + 1) : action;
  const entry = CONTROLS.find((candidate) => keyNameOf(candidate) === name);
  if (!entry) return;
  const id = entry.definition.capability.id;
  const resolved = entry.programs && !entry.programs.includes(program) ? undefined : host.capability(id);
  if (!resolved) { say(`${entry.definition.label}: this program has no such control.`); return; }
  let values: ActionValues = {};
  if (resolved.action.inputs.some((input) => input.required === true && isShown(input, values) && !('impliedBy' in input.typed))) {
    const formed = await host.openForm(id, values, { title: 'This conversation', given: [], display: {} });
    // A form left with Esc is a change of mind: nothing ran, and nothing needs saying.
    if (!formed) { host.requestRender(); return; }
    values = formed;
  }
  const risk = effectiveRisk(resolved.action, values);
  if ((risk === 'cannot-be-undone' || risk === 'loosens-a-protection') && !resolved.action.asksItself) {
    const yes = await host.confirm({
      title: `${resolved.action.label}?`,
      body: `${actionSentence(resolved.action, values)} ${riskSentences(resolved.action, values)}`,
      confirmLabel: actionButton(resolved.action),
    });
    if (!yes) { host.requestRender(); return; }
  }
  const outcome = await host.runCapability(id, values);
  if (!outcome.ok) { say(`${resolved.action.label}: not done: ${outcome.reason}`); host.requestRender(); return; }
  const done = actionDoneLine(resolved.action, values);
  const lines = [done, ...outcome.lines.filter((line) => line !== done)].filter((line) => line.trim() !== '');
  say(lines.length > 0 ? lines.join('\n') : `${resolved.action.label}: done.`);
  host.requestRender();
}
