/**
 * pinned-lines-entries.ts, the "Pinned lines" list of This conversation (conversation-place.ts adds it): the lines
 * pinned in this conversation with `!#` or `#`, which the model keeps seeing after every compaction. Read from the
 * program's own conversation (builtin/pinned-lines.ts), again after each change; Enter changes the selected line and
 * `x` unpins it (it asks first: an unpinned line is gone).
 */
import type { SessionCapabilityServices } from '../agent-turn/capability-tools.js';
import type { PlaceProgramSource } from './place-host.js';
import type { PlaceAction, PlaceItem, PlaceList } from './place-types.js';

export interface PinnedLineItem extends PlaceItem {
  readonly kind: 'pinned-line';
  readonly state: 'pinned';
  readonly text: string;
  readonly createdAt: number;
}

export const PINNED_LINES_SOURCE = 'conversation-pinned-lines';

/** The pinned lines, read from this program's conversation when asked. */
export function pinnedLinesPlaceSource(services: (() => SessionCapabilityServices | undefined) | undefined): Readonly<Record<string, PlaceProgramSource>> {
  return {
    [PINNED_LINES_SOURCE]: {
      read: async () => {
        const pinned = services?.()?.pinned;
        if (!pinned) throw new Error('this program has no open conversation');
        return pinned.list().map((line): PinnedLineItem => ({ kind: 'pinned-line', id: line.id, state: 'pinned', text: line.text, createdAt: line.createdAt }));
      },
      // They change only through this place, the composer (`#`) or the model: the place reads them on opening and after each action.
      subscribe: () => () => {},
    },
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const PINNED_LINES_LIST: PlaceList<PinnedLineItem> = {
  id: 'pinned-lines',
  label: 'Pinned lines',
  noun: 'the lines pinned in this conversation',
  source: { kind: 'program', name: PINNED_LINES_SOURCE, items: (raw) => (Array.isArray(raw) ? raw as PinnedLineItem[] : []) },
  empty: 'No pinned lines: start a message with # to pin a line the model keeps seeing after compaction.',
  row: (item) => ({ title: oneLine(item.text).slice(0, 80), right: item.id }),
  detail: (item) => [
    { text: item.text },
    { text: '' },
    { label: 'Pinned', text: new Date(item.createdAt).toLocaleTimeString() },
    { text: 'The model sees it again after every compaction, for as long as this conversation lasts.', tone: 'muted' as const },
  ],
};

export const PINNED_LINES_ACTIONS: readonly PlaceAction<PinnedLineItem>[] = [
  { key: 'enter', id: 'pinned-line-change', list: 'pinned-lines', capability: 'pinned.change', label: 'change', fill: { line: 'id' } },
  { key: 'x', id: 'pinned-line-unpin', list: 'pinned-lines', capability: 'pinned.delete', label: 'unpin', fill: { line: 'id' } },
];
