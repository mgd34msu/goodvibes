/**
 * Per-conversation reading shared by the Slack and Discord inboxes.
 *
 * Each conversation keeps its own cursor (Unix ms: every message at or before
 * it has been read). A tick visits conversations in turn, starting after the
 * last one the previous tick reached, and reads each one's window (cursor, now).
 * A provider that pages forward (Discord, `readForward`) is read oldest page
 * first from the cursor and stops once it holds more than the item budget, so
 * each message is read about once. One that pages only newest first (Slack,
 * `readPage`) is read down to the cursor, and the window it read is kept across
 * passes (up to RETAINED_WINDOW_ITEMS messages and RETAINED_WINDOW_CHARS of
 * text) so a backlog is drained from memory instead of being read again on
 * every pass. The oldest messages are screened and kept, up to the tick's item
 * budget, and the conversation's cursor moves to the newest message kept (a
 * quiet conversation keeps its cursor and costs one empty page per tick). A
 * conversation whose window is larger than one tick's page budget continues
 * from where it stopped on the next tick. A failure ends the tick at that conversation; what earlier
 * conversations read is kept, and the next tick starts with the right one: the
 * same conversation after a rate limit, the next one after a failure that
 * belongs to this conversation.
 */
import type { InboundChannelItem } from '../provider-adapter.js';
import type { ProtectedInboxPreview, ProtectedInboxPreviewFields } from '../protected-preview.js';

export interface ScanCandidate {
  /** Unique within the provider: `<conversation>:<message id>`. */
  readonly key: string;
  readonly conversation: string;
  readonly senderId: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly kind: InboundChannelItem['kind'];
}

export interface ScanPage {
  readonly candidates: readonly ScanCandidate[];
  /** Where to continue toward older messages; absent once the window's floor is reached. */
  readonly next?: string;
}

/** A failure that ends the tick. `conversation` failures move the next tick on to the following conversation. */
export class ScanFailure extends Error {
  constructor(message: string, readonly scope: 'tick' | 'conversation', readonly refreshCatalog: boolean) { super(message); }
}

/** State a reader keeps between ticks; lives in memory, rebuilt from the cursors after a restart. */
export interface ConversationScanState {
  /** Conversation the next tick starts with. */
  next?: string | undefined;
  /** Windows read partly, or read whole and not yet drained, by conversation. */
  readonly resume: Map<string, ScanWindow>;
}

interface ScanWindow {
  readonly floor: number;
  readonly upper: number;
  next?: string | undefined;
  kept: ScanCandidate[];
  /** Read down to its floor: `kept` holds every message in (floor, keptBelow). */
  complete?: boolean | undefined;
  /** Messages at or after this time were read and let go to bound memory; set when any were. */
  keptBelow?: number | undefined;
}

/** A newest-first window kept across passes holds at most this many messages... */
const RETAINED_WINDOW_ITEMS = 1_000;
/** ...and at most this much message text (characters), so many busy conversations stay small in memory. */
const RETAINED_WINDOW_CHARS = 1_000_000;

export function createConversationScanState(): ConversationScanState {
  return { resume: new Map() };
}

export interface ConversationScanOptions {
  readonly conversations: readonly string[];
  readonly floorOf: (conversation: string) => number;
  /** Exclusive upper bound for windows started this tick (Unix ms). */
  readonly cutoff: number;
  /** Items this tick may keep. */
  readonly limit: number;
  /** History requests this tick may make. */
  readonly pageBudget: number;
  readonly state: ConversationScanState;
  /** Newest page first, from `upper` (or `continueFrom`) down toward `floor`. A reader gives this or `readForward`. */
  readPage?(conversation: string, window: { readonly floor: number; readonly upper: number; readonly continueFrom?: string }): Promise<ScanPage>;
  /**
   * Oldest page first, from `floor` (or after `continueFrom`) up toward
   * `upper`; `next` is where the following page starts. Preferred when given.
   */
  readForward?(conversation: string, window: { readonly floor: number; readonly upper: number; readonly continueFrom?: string }): Promise<ScanPage>;
  map(candidate: ScanCandidate): Promise<ProtectedInboxPreview>;
  toItem(candidate: ScanCandidate, fields: ProtectedInboxPreviewFields): InboundChannelItem;
  checkActive(): void;
}

export interface ConversationScanOutcome {
  readonly items: InboundChannelItem[];
  /** Conversation → newest time read completely, for the conversations that moved. */
  readonly advance: Record<string, number>;
  readonly failure?: ScanFailure;
}

/** Keep the oldest messages of a window; the newest are let go past the caps, and the window records from when. */
function insertOldest(window: ScanWindow, candidate: ScanCandidate, cap: number, minimum: number): void {
  const kept = window.kept;
  if (kept.some(entry => entry.key === candidate.key)) return;
  kept.push(candidate);
  kept.sort((a, b) => a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let chars = 0;
  for (const entry of kept) chars += entry.text.length;
  while (kept.length > minimum && (kept.length > cap || chars > RETAINED_WINDOW_CHARS)) {
    const dropped = kept.pop()!;
    chars -= dropped.text.length;
    window.keptBelow = Math.min(window.keptBelow ?? Number.POSITIVE_INFINITY, dropped.receivedAt);
  }
}

export async function scanConversations(options: ConversationScanOptions): Promise<ConversationScanOutcome> {
  const { state, conversations } = options;
  const items: InboundChannelItem[] = [];
  const advance: Record<string, number> = {};
  if (conversations.length === 0) return { items, advance };
  const start = state.next === undefined ? 0 : Math.max(0, conversations.indexOf(state.next));
  const order = [...conversations.slice(start), ...conversations.slice(0, start)];
  let pages = options.pageBudget;
  let left = options.limit;
  state.next = undefined;
  for (let index = 0; index < order.length; index += 1) {
    const conversation = order[index]!;
    const following = order[index + 1] ?? order[0];
    if (left <= 0 || pages <= 0) { state.next = conversation; break; }
    options.checkActive();
    const floor = options.floorOf(conversation);
    const forward = options.readForward;
    let window = state.resume.get(conversation);
    if (window?.complete && floor >= window.floor && floor < (window.keptBelow ?? window.upper)) {
      // A window read whole on an earlier pass still covers the cursor: drain it, no request.
      window.kept = window.kept.filter(candidate => candidate.receivedAt > floor);
      if (window.kept.length === 0) window = undefined;
    } else if (window && (window.complete || window.floor !== floor)) {
      window = undefined;
    }
    if (!window) window = { floor, upper: options.cutoff, kept: [] };
    // Forward reading needs only the oldest budget's worth; newest-first reading keeps the window to drain later.
    const cap = forward ? options.limit + 1 : Math.max(options.limit + 1, RETAINED_WINDOW_ITEMS);
    let complete = window.complete === true;
    while (!complete && pages > 0) {
      pages -= 1;
      let page: ScanPage;
      const range = { floor, upper: window.upper, ...(window.next === undefined ? {} : { continueFrom: window.next }) };
      try {
        const read = forward ?? options.readPage;
        if (!read) throw new ScanFailure('The inbox reader has no way to page history; this is a defect, report it', 'tick', false);
        page = await read.call(options, conversation, range);
      } catch (error) {
        state.resume.set(conversation, window);
        const failure = error instanceof ScanFailure ? error : new ScanFailure('The inbox read failed; the next poll tries again', 'tick', true);
        state.next = failure.scope === 'conversation' ? following : conversation;
        return { items, advance, failure };
      }
      options.checkActive();
      for (const candidate of page.candidates) {
        if (candidate.receivedAt <= floor || candidate.receivedAt >= window.upper) continue;
        insertOldest(window, candidate, cap, options.limit + 1);
      }
      if (page.next === undefined) { complete = true; break; }
      window.next = page.next;
      // Read oldest first, the budget's worth already held is the oldest of the window.
      if (forward && window.kept.length > options.limit) { complete = true; break; }
    }
    if (!complete) { state.resume.set(conversation, window); state.next = conversation; break; }
    const keptBelow = window.keptBelow;
    if (!forward && keptBelow !== undefined) {
      // Everything read below the first message let go is held; nothing from that millisecond up is.
      window.kept = window.kept.filter(candidate => candidate.receivedAt < keptBelow);
    }
    const candidates = window.kept;
    // Held until drained, so a pass that stops below keeps what this one read; replaced or dropped once messages are taken.
    if (forward) state.resume.delete(conversation);
    else state.resume.set(conversation, { floor, upper: window.upper, kept: candidates, complete: true, ...(keptBelow === undefined ? {} : { keptBelow }) });
    let selected = candidates.slice(0, left);
    const omitted = candidates[left];
    // Never split one millisecond: the cursor is in milliseconds.
    if (omitted) selected = selected.filter(candidate => candidate.receivedAt < omitted.receivedAt);
    if (candidates.length > 0 && selected.length === 0) {
      if (left < options.limit) { state.next = conversation; break; }
      selected = candidates.filter(candidate => candidate.receivedAt === candidates[0]!.receivedAt);
    }
    // The cursor moves to the newest message kept, never to "now": a message
    // the provider shows a moment late is still above the cursor next tick.
    let through = selected.length > 0 ? selected[selected.length - 1]!.receivedAt : floor;
    let screeningStopped = false;
    for (const candidate of selected) {
      options.checkActive();
      const preview = await options.map(candidate);
      options.checkActive();
      if (preview.status === 'unavailable') { through = candidate.receivedAt - 1; screeningStopped = true; break; }
      items.push(options.toItem(candidate, preview.fields));
      left -= 1;
    }
    if (through > floor) advance[conversation] = through;
    if (!forward) {
      const rest = candidates.filter(candidate => candidate.receivedAt > through);
      if (rest.length > 0) state.resume.set(conversation, { floor, upper: window.upper, kept: rest, complete: true, ...(keptBelow === undefined ? {} : { keptBelow }) });
      else state.resume.delete(conversation);
    }
    if (screeningStopped) {
      state.next = conversation;
      return { items, advance, failure: new ScanFailure('Privacy screening is unavailable right now, so new messages wait; the next poll screens them', 'tick', false) };
    }
    if (selected.length < candidates.length) { state.next = following; break; }
  }
  return { items, advance };
}
