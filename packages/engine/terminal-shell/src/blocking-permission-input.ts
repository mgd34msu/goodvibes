import { TYPEAHEAD_BURST_GAP_MS, TYPEAHEAD_SETTLE_MS, isTypingInput } from './typeahead-gate.js';
// The startup offer's gate is the same rule; it is reached through this module's package path.
export {
  TYPEAHEAD_BURST_GAP_MS,
  TYPEAHEAD_SETTLE_MS,
  createStartupTypeaheadGate,
  isTypingInput,
  type StartupTypeaheadGate,
  type StartupTypeaheadGateOptions,
} from './typeahead-gate.js';

/**
 * Common explicit permission keys: `y` approves once, `n` denies. Approving and
 * remembering is never one bare key; each product offers it as a two-key
 * gesture (choose, then Enter). Denial and escape policy are construction-owned
 * product choices.
 */
export function handleSimplePermissionInput(
  data: string,
  ports: {
    readonly escapeDenies: boolean;
    readonly abortOnDeny: boolean;
    readonly resolve: (approved: boolean) => void;
    readonly abort: () => void;
    readonly render: () => void;
  },
): boolean {
  const key = data.toLowerCase().trim();
  const deny = key === 'n' || (ports.escapeDenies && (data === '\x1b' || data === '\x03'));
  if (key !== 'y' && !deny) return false;
  ports.resolve(!deny);
  if (deny && ports.abortOnDeny) ports.abort();
  ports.render();
  return true;
}

/** Typing state of one open card, kept on the pending card itself. */
export interface CardTypeahead {
  /** When the card was put on screen. */
  readonly openedAt: number;
  /** The last key that was treated as typing for the composer. */
  readonly lastTypedAt?: number | undefined;
  /** Set by the first key that answered the card; from then on every key is the card's. */
  readonly addressed?: boolean | undefined;
}

/**
 * Whether one stdin chunk that arrives while a card is open answers the card
 * or belongs to the sentence being typed. The same rule as the startup gate
 * (typeahead-gate.ts): a key within the settle time of the card appearing, or
 * within the burst gap of the previous typed key, continues the typing and
 * goes to the composer; so does every key while the composer holds a draft.
 * The first key after a pause, with an empty composer, addresses the card,
 * and Tab always does. Mouse and focus reports are never typing.
 */
export function routeCardInput(
  chunk: string,
  card: CardTypeahead,
  now: number,
  composerEmpty = true,
): { readonly answer: boolean; readonly card: CardTypeahead } {
  if (card.addressed || !isTypingInput(chunk)) return { answer: true, card };
  // Tab is never typing aimed at the composer while a card waits: it moves to the card.
  if (chunk === '\t') return { answer: true, card: { ...card, addressed: true } };
  const typeahead = !composerEmpty
    || now - card.openedAt <= TYPEAHEAD_SETTLE_MS
    || (card.lastTypedAt !== undefined && now - card.lastTypedAt <= TYPEAHEAD_BURST_GAP_MS);
  if (typeahead) return { answer: false, card: { ...card, lastTypedAt: now } };
  return { answer: true, card: { ...card, addressed: true } };
}

/**
 * True while a card's keys go to the composer because it holds a draft and
 * the card has not been addressed: the card then says only that Tab moves to
 * it (and that Ctrl+C still denies), since its answer keys would type into
 * the draft.
 */
export function cardAwaitsTab(card: { readonly addressed?: boolean | undefined }, composerEmpty: boolean): boolean {
  return !composerEmpty && card.addressed !== true;
}
