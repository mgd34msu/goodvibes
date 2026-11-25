/**
 * The lines pinned in this conversation (`!#` / `#` in the composer): kept by the program holding the conversation for
 * as long as it lasts, and given to the model again after every compaction. Listed, changed and removed here; the
 * This conversation place shows them as its "Pinned lines" list.
 */
import { CapabilityRefusal, type CapabilityDefinition } from '../types.js';
import { wordsInput } from './agent-stores.js';

/** One pinned line. */
export interface PinnedLine {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
}

/** The conversation's pinned lines (the program's session memory store). */
export interface PinnedLinesServices {
  readonly pinned?: {
    list(): readonly PinnedLine[];
    /** False when there is no such line, or the text is blank. */
    change(id: string, text: string): boolean;
    /** False when there is no such line. */
    remove(id: string): boolean;
  } | undefined;
}

const NO_CONVERSATION = 'This program has no open conversation to pin lines in; nothing was done.';
const LINE = wordsInput({ id: 'line', label: 'Pinned line', help: 'Its id, such as mem-1 (the list shows them)', why: 'a pinned line\'s id', typed: { position: 1 } });

function pinnedOf(services: PinnedLinesServices): NonNullable<PinnedLinesServices['pinned']> {
  if (!services.pinned) throw new CapabilityRefusal(NO_CONVERSATION);
  return services.pinned;
}

function lineOf(services: PinnedLinesServices, id: string): PinnedLine {
  const found = pinnedOf(services).list().find((line) => line.id === id.trim());
  if (!found) throw new CapabilityRefusal(`No pinned line ${id} in this conversation; nothing was done.`, 'The pinned lines are listed in This conversation.', 'NOT_FOUND');
  return found;
}

export const PINNED_LIST: CapabilityDefinition<PinnedLinesServices> = {
  capability: { id: 'pinned.list', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'list', label: 'See the pinned lines', word: 'list', inputs: [],
  sentence: 'Lists the lines pinned in this conversation, which the model keeps seeing after every compaction.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.pinned !== undefined,
  async run(_values, services) {
    const lines = pinnedOf(services).list();
    return {
      text: lines.length === 0 ? 'No pinned lines in this conversation: start a message with # to pin one.'
        : [`Pinned lines (${lines.length})`, ...lines.map((line) => `  ${line.id}  ${line.text}`)].join('\n'),
      data: { lines: lines.map((line) => ({ id: line.id, text: line.text, createdAt: new Date(line.createdAt).toISOString() })) },
    };
  },
};

export const PINNED_CHANGE: CapabilityDefinition<PinnedLinesServices> = {
  capability: { id: 'pinned.change', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'change', label: 'Change a pinned line', word: 'change',
  inputs: [LINE, wordsInput({ id: 'text', label: 'Text', help: 'What the line says now', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
  sentence: 'Pinned line {line} says "{text}" for the rest of this conversation.', done: '',
  touches: 'this-machine', lasts: 'session', risk: 'none', example: { line: 'mem-1', text: 'Answer in British English.' },
  available: (services) => services.pinned !== undefined,
  async run(values, services) {
    const line = lineOf(services, values.line!);
    if (!pinnedOf(services).change(line.id, values.text ?? '')) throw new CapabilityRefusal('A pinned line cannot be blank; nothing was changed.', 'To remove it, use "Unpin a line".');
    return { text: `Changed pinned line ${line.id}.`, data: { line: line.id } };
  },
};

export const PINNED_DELETE: CapabilityDefinition<PinnedLinesServices> = {
  capability: { id: 'pinned.delete', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'delete', label: 'Unpin a line', word: 'delete', inputs: [LINE],
  sentence: 'Pinned line {line} is removed: the model no longer sees it after a compaction.', done: '',
  touches: 'this-machine', lasts: 'session', risk: 'cannot-be-undone', example: { line: 'mem-1' },
  available: (services) => services.pinned !== undefined,
  async run(values, services) {
    const line = lineOf(services, values.line!);
    pinnedOf(services).remove(line.id);
    return { text: `Unpinned line ${line.id} ("${line.text.slice(0, 60)}").`, data: { line: line.id } };
  },
};

export const PINNED_CAPABILITIES = [PINNED_LIST, PINNED_CHANGE, PINNED_DELETE] as const;
