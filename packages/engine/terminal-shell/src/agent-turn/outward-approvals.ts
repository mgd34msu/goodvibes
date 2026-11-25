/**
 * outward-approvals.ts, the agent's answer to "what actually clears this?"
 *
 * The refusal the owner met named a remedy that did not exist: reply "send it
 * now". He replied. It refused again, in the same words. Nothing in the whole
 * product had ever minted an `OwnerApproval`, the factory had test callers
 * only, so the advice was fiction, and the retry could not have worked.
 *
 * The tempting repair is to make the phrase work. That would be worse than the
 * bug. A boundary cleared by a sentence in the conversation is cleared by
 * anything that can put that sentence in the conversation, and steering a
 * conversation toward producing a particular sentence is what the content this
 * boundary exists to stop is good at. The remedy has to be something content
 * cannot produce, and a phrase never is.
 *
 * ── What clears it here ───────────────────────────────────────────────────
 *
 * The owner's own answer to the send in his inbox (Waiting for you, Sends:
 * places/held-sends-inbox.ts posts each refusal there). Two properties make
 * that a gesture rather than text:
 *
 *  - It is handled by the surface's input layer, not by the model. The words
 *    never become tokens the model chooses to emit; they are keystrokes the
 *    process read off its own input widget.
 *  - The one path by which a model CAN reach a slash command,
 *    `agent_harness mode:"run_command"`, marks its context `invokedByModel`,
 *    and the approval route refuses on that flag. Without this the fix would
 *    have been theatre: injected text steers the model, the model runs the
 *    command, the approval appears, and the send goes.
 *
 * The approval that results is bound to the exact message it was shown, single
 * use, and expires in minutes, see the platform's security/owner-approval.ts for
 * why an approval naming only an action id is a standing permit rather than an
 * approval of the deed.
 */

import { OwnerApprovalStore } from '@goodvibes/engine/platform/platform/security';

/**
 * One store per process, shared by the tool that asks and the command that
 * answers. They are different call stacks in the same process and must be
 * looking at the same pending approvals or the gesture clears nothing.
 */
let store: OwnerApprovalStore | null = null;
let pending: PendingOutwardAction[] = [];
let nextPendingId = 1;

export function getOutwardApprovalStore(): OwnerApprovalStore {
  store ??= new OwnerApprovalStore();
  return store;
}

export function resetOutwardApprovalStoreForTests(): void {
  store = null;
  pending = [];
  nextPendingId = 1;
}

/** The gesture, in the owner's words. Named once so the refusal cannot drift from it. */
export const OUTWARD_APPROVAL_GESTURE =
  'send it yourself from Waiting for you, under Sends (in this Agent, the terminal app, the web UI or a phone): it shows the refused message exactly as it would go out and sends it when you say so. '
  + 'It is a press of yours rather than a phrase on purpose: anything you could be talked into typing, '
  + 'content that was just read could talk the agent into producing.';

/** What performing an approved action came to. */
export interface OutwardActionOutcome {
  readonly ok: boolean;
  readonly text: string;
}

/** A refused outward action the owner can still approve. */
export interface PendingOutwardAction {
  /** Its number among the sends held here (Waiting for you, Sends, names it by its item). */
  readonly id: number;
  readonly action: string;
  readonly description: string;
  /** Exactly what would leave the machine; this is what the owner is shown and what is sent. */
  readonly content: Readonly<Record<string, string | undefined>>;
  readonly at: number;
  /**
   * Performs this exact action with the recorded content. Run only from the
   * owner's own "approve" on the send in Waiting for you, so the bytes approved are the bytes sent.
   */
  readonly perform?: (() => Promise<OutwardActionOutcome>) | undefined;
}

/** How long a refused action stays approvable, matching the approval's own window. */
const PENDING_TTL_MS = 5 * 60 * 1000;
/** Refusals kept for approval; older ones drop off. */
const MAX_PENDING = 5;

function live(): PendingOutwardAction[] {
  const now = Date.now();
  pending = pending.filter((entry) => now - entry.at <= PENDING_TTL_MS);
  return pending;
}

/** The same deed: one action with the same content, compared key by key in sorted order. */
function sameDeed(entry: PendingOutwardAction, action: string, content: PendingOutwardAction['content']): boolean {
  return entry.action === action && contentKey(entry.content) === contentKey(content);
}

function contentKey(content: PendingOutwardAction['content']): string {
  return JSON.stringify(Object.keys(content).sort().filter((key) => content[key] !== undefined).map((key) => [key, content[key]]));
}

/**
 * Remember what was just refused.
 *
 * The owner approves an action he has been SHOWN, so the thing he approves has
 * to be recorded at the moment of refusal, otherwise his "approve" would
 * be approving whatever came next, which is a blank cheque. Several refusals
 * in one turn each stay approvable; a refusal of the same action with the same
 * content as one already waiting refreshes that entry (keeping its number)
 * instead of adding a second, so one approval can never send it twice.
 */
export function rememberRefusedOutwardAction(input: Omit<PendingOutwardAction, 'at' | 'id'>): PendingOutwardAction {
  const entries = live();
  const same = entries.find((entry) => sameDeed(entry, input.action, input.content));
  const entry: PendingOutwardAction = { ...input, id: same?.id ?? nextPendingId++, at: Date.now() };
  pending = [...entries.filter((existing) => existing !== same), entry].slice(-MAX_PENDING);
  changed();
  return entry;
}

const listeners = new Set<() => void>();

/** Told when a refusal is added or taken (a list showing them reads again); returns the stop. */
export function onRefusedOutwardActionsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function changed(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a list that failed to read again reads on its next change */ }
  }
}

/** Every refusal still approvable, oldest first. */
export function listRefusedOutwardActions(): readonly PendingOutwardAction[] {
  return [...live()];
}

/** Remove and return one refusal by number, or the newest when no number is given. */
export function takeRefusedOutwardAction(id?: number): PendingOutwardAction | null {
  const entries = live();
  const held = id === undefined ? entries.at(-1) : entries.find((entry) => entry.id === id);
  if (!held) return null;
  // The approval covers this send: any other waiting entry for the same deed goes with it.
  pending = entries.filter((entry) => !sameDeed(entry, held.action, held.content));
  changed();
  return held;
}

export function peekRefusedOutwardAction(): PendingOutwardAction | null {
  return live().at(-1) ?? null;
}
