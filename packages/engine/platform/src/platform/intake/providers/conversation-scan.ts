/**
 * Per-conversation reading shared by the Slack and Discord inboxes.
 *
 * Each conversation keeps its own cursor (Unix ms: every message at or before
 * it has been read). A tick visits conversations in turn, starting after the
 * last one the previous tick reached, and reads each one's window (cursor, now)
 * newest page first down to its cursor. The oldest messages of the window are
 * screened and kept, up to the tick's item budget, and the conversation's
 * cursor moves to the newest message kept (a quiet conversation keeps its
 * cursor and costs one empty page per tick). A conversation whose window is
 * larger than one tick's page budget continues from where it stopped on the
 * next tick. A failure ends the tick at that conversation; what earlier
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
  /** Windows read partly, newest first, by conversation. */
  readonly resume: Map<string, { readonly floor: number; readonly upper: number; next?: string | undefined; kept: ScanCandidate[] }>;
}

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
  readPage(conversation: string, window: { readonly floor: number; readonly upper: number; readonly continueFrom?: string }): Promise<ScanPage>;
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

function insertOldest(kept: ScanCandidate[], candidate: ScanCandidate, cap: number): void {
  if (kept.some(entry => entry.key === candidate.key)) return;
  kept.push(candidate);
  kept.sort((a, b) => a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (kept.length > cap) kept.length = cap;
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
    let window = state.resume.get(conversation);
    if (!window || window.floor !== floor) window = { floor, upper: options.cutoff, kept: [] };
    let reachedFloor = false;
    while (pages > 0) {
      pages -= 1;
      let page: ScanPage;
      try {
        page = await options.readPage(conversation, { floor, upper: window.upper, ...(window.next === undefined ? {} : { continueFrom: window.next }) });
      } catch (error) {
        state.resume.set(conversation, window);
        const failure = error instanceof ScanFailure ? error : new ScanFailure('The inbox read failed; the next poll tries again', 'tick', true);
        state.next = failure.scope === 'conversation' ? following : conversation;
        return { items, advance, failure };
      }
      options.checkActive();
      for (const candidate of page.candidates) {
        if (candidate.receivedAt <= floor || candidate.receivedAt >= window.upper) continue;
        insertOldest(window.kept, candidate, options.limit + 1);
      }
      if (page.next === undefined) { reachedFloor = true; break; }
      window.next = page.next;
    }
    if (!reachedFloor) { state.resume.set(conversation, window); state.next = conversation; break; }
    state.resume.delete(conversation);
    const candidates = window.kept;
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
    if (screeningStopped) {
      state.next = conversation;
      return { items, advance, failure: new ScanFailure('Privacy screening is unavailable right now, so new messages wait; the next poll screens them', 'tick', false) };
    }
    if (selected.length < candidates.length) { state.next = following; break; }
  }
  return { items, advance };
}
