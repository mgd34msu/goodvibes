/**
 * Calls Jev decided for the owner at the permission gate (permissions.mode
 * jev-decides or just-vibes), kept so the owner can see each one and reverse
 * it: Waiting for you's Decisions list in both terminal apps and the web UI,
 * with never (again), always and ask (always ask me), or keep.
 *
 * The gate records every Jev decision here (PermissionManager). The process
 * that holds the gate posts each one to the owner inbox, the home's one store,
 * as a `decision` item, and carries out the owner's choice on it there:
 * never, always and ask save a standing rule for calls like it in the same
 * rule store the gate reads (the one a remembered answer is written to). A
 * choice is carried out before it is recorded, so the item's answer says what
 * was done; a choice that cannot be done is refused and the item stays open.
 *
 * No decision can be undone from here: it is posted when the gate makes it,
 * before its call runs, and the gate never puts a change the program records
 * for undo to Jev (a recoverable write inside the project is allowed by code,
 * gate/classify.ts; one outside it is refused by the tool,
 * utils/path-safety.ts). A change is taken back with /undo.
 *
 * One ledger per process, like the process's gate. Bounded: the oldest
 * decision is dropped past JEV_DECISIONS_CAPACITY, and its item says so when
 * the owner acts on it.
 *
 * Cost: one inbox row per Jev decision (already one model request each) and
 * nothing per ordinary call.
 */
import type { PolicyRule } from '../runtime/permissions/types.js';

/** A call Jev decided for the owner. */
export interface JevDecisionRecord {
  /** Short id within this process (`j3`). */
  readonly id: string;
  readonly toolName: string;
  /** What the call would do, as the gate summarized it. */
  readonly summary: string;
  /** What the call does, in the words its ask would have used ("Change notes.md"); the decision is said in them. */
  readonly act?: string | undefined;
  readonly approved: boolean;
  /** Jev's reason, in its words. */
  readonly reason: string;
  /** The decision log row. */
  readonly decisionId: string;
  readonly decidedAt: number;
  /** What a standing rule made from this call covers, in words; absent when none can be made. */
  readonly scope?: string | undefined;
}

/** A standing rule the owner can set from a decision. */
export type JevDecisionRuleEffect = PolicyRule['effect'];

interface Entry extends JevDecisionRecord {
  /** Save a standing rule for calls like this one; resolves with what it covers. */
  readonly remember?: ((effect: JevDecisionRuleEffect) => Promise<string>) | undefined;
}

export const JEV_DECISIONS_CAPACITY = 200;

export class JevDecisionLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(decision: JevDecisionRecord) => void>();
  private sequence = 0;

  /** Told of every new decision; returns the unsubscribe. */
  subscribe(listener: (decision: JevDecisionRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  record(decision: Omit<JevDecisionRecord, 'id' | 'decidedAt'>,
    remember?: (effect: JevDecisionRuleEffect) => Promise<string>): JevDecisionRecord {
    const entry: Entry = { ...decision, id: `j${(++this.sequence).toString()}`, decidedAt: Date.now(), ...(remember ? { remember } : {}) };
    this.entries.set(entry.id, entry);
    if (this.entries.size > JEV_DECISIONS_CAPACITY) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const view = viewOf(entry);
    for (const listener of [...this.listeners]) {
      try { listener(view); } catch { /* One listener cannot stop the gate or another listener. */ }
    }
    return view;
  }

  get(id: string): JevDecisionRecord | undefined {
    const entry = this.entries.get(id);
    return entry ? viewOf(entry) : undefined;
  }

  /** Save a standing rule for calls like decision `id`; throws with the reason when none can be saved. */
  async remember(id: string, effect: JevDecisionRuleEffect): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('This decision is older than the ones this session keeps; add a standing rule in Permissions and safety, Rules ("add a rule") instead.');
    if (!entry.remember || entry.scope === undefined) throw new Error(`No standing rule can be made from this ${entry.toolName} call; add one in Permissions and safety, Rules ("add a rule") instead.`);
    return await entry.remember(effect);
  }
}

function viewOf(entry: Entry): JevDecisionRecord {
  return {
    id: entry.id, toolName: entry.toolName, summary: entry.summary, approved: entry.approved, reason: entry.reason,
    decisionId: entry.decisionId, decidedAt: entry.decidedAt,
    ...(entry.act !== undefined ? { act: entry.act } : {}),
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
  };
}

const processLedger = new JevDecisionLedger();

/** This process's Jev decisions: the gate writes them, the inbox bridge posts them and carries out the owner's choices. */
export function processJevDecisions(): JevDecisionLedger {
  return processLedger;
}

/** The part of the owner inbox decisions are posted to (control-plane/owner-inbox.ts). */
export interface JevDecisionInbox {
  postNow(item: {
    readonly kind: 'decision'; readonly title: string; readonly detail?: string | undefined;
    readonly options?: readonly string[] | undefined; readonly key?: string | undefined; readonly expiresAt?: number | undefined;
    readonly askedBy?: string | undefined; readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
  }): { readonly item: { readonly id: string } };
  withdraw(id: string, reason: string): unknown;
}

/** The choices on a decision item, as the owner types them. */
export const JEV_DECISION_CHOICES = Object.freeze({
  keep: 'keep',
  never: 'never',
  always: 'always',
  ask: 'ask',
} as const);

/** A day: long enough to act on, short enough that the open list stays the current session's. */
const DECISION_ITEM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DECISION_KEY_PREFIX = 'jev:';

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "Jev allowed this for you: change notes.md": what was decided, in the words of the call's own ask. */
function decisionSentence(decision: Pick<JevDecisionRecord, 'approved' | 'act' | 'summary'>): string {
  const act = decision.act ?? decision.summary.replace(/[.\s]+$/, '');
  return `Jev ${decision.approved ? 'allowed' : 'refused'} this for you: ${act.charAt(0).toLowerCase()}${act.slice(1)}`;
}

/**
 * Post every decision this process's gate records to the owner inbox and carry
 * out the owner's choices on them. `handle` is control-plane/owner-inbox.ts
 * `handleOwnerDecisions` (passed in, so the gate does not import the inbox).
 * `surface` names this app in the item, so another app can say where it was
 * made. Returns the function that stops it, which also withdraws the items
 * still open, since nothing could carry out a choice on them afterwards.
 */
export function bridgeJevDecisionsToInbox(
  ledger: JevDecisionLedger,
  inbox: JevDecisionInbox,
  options: {
    readonly surface: string;
    readonly handle: (keyPrefix: string, handler: (item: { readonly key?: string | undefined }, option: string) => Promise<string>) => () => void;
  },
): () => void {
  const prefix = `${DECISION_KEY_PREFIX}${options.surface}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}:`;
  const posted = new Map<string, string>();
  const stopHandling = options.handle(prefix, async (item, option) => {
    const id = item.key?.slice(prefix.length) ?? '';
    const decision = ledger.get(id);
    if (!decision) throw new Error('This decision is older than the ones this session keeps; add a standing rule in Permissions and safety, Rules ("add a rule") instead.');
    switch (option) {
      case JEV_DECISION_CHOICES.keep:
        return `Kept: Jev ${decision.approved ? 'allowed' : 'refused'} it, and nothing changed.`;
      case JEV_DECISION_CHOICES.never:
        return `Never again: ${await ledger.remember(id, 'deny')}.`;
      case JEV_DECISION_CHOICES.always:
        return `Always: ${await ledger.remember(id, 'allow')}.`;
      case JEV_DECISION_CHOICES.ask:
        return `Always ask you: ${await ledger.remember(id, 'ask')}.`;
      default:
        throw new Error(`"${option}" is not a choice on a decision.`);
    }
  });
  const stopListening = ledger.subscribe((decision) => {
    const choices = [
      JEV_DECISION_CHOICES.keep,
      ...(decision.scope !== undefined ? [JEV_DECISION_CHOICES.never, JEV_DECISION_CHOICES.always, JEV_DECISION_CHOICES.ask] : []),
    ];
    try {
      const { item } = inbox.postNow({
        kind: 'decision',
        key: `${prefix}${decision.id}`,
        // One sentence, the same on every surface: what Jev allowed or refused, in the words the ask would have used.
        title: clip(decisionSentence(decision), 200),
        detail: clip([
          `Why: ${decision.reason}`,
          ...(decision.scope !== undefined ? [`A standing rule from it would cover ${decision.scope.charAt(0).toLowerCase()}${decision.scope.slice(1)}.`] : []),
          'keep leaves it as decided; never, always and ask set a standing rule for calls like it.',
        ].join('\n'), 4000),
        options: choices,
        askedBy: 'Jev',
        expiresAt: decision.decidedAt + DECISION_ITEM_LIFETIME_MS,
        metadata: {
          surface: options.surface,
          tool: decision.toolName,
          verdict: decision.approved ? 'allowed' : 'refused',
          decisionId: clip(decision.decisionId, 1000),
        },
      });
      posted.set(decision.id, item.id);
      while (posted.size > JEV_DECISIONS_CAPACITY) {
        const oldest = posted.keys().next();
        if (oldest.done) break;
        posted.delete(oldest.value);
      }
    } catch { /* An unreadable inbox leaves the decision in the gate's own record only. */ }
  });
  return () => {
    stopListening();
    stopHandling();
    for (const itemId of posted.values()) {
      try { inbox.withdraw(itemId, 'The session that made this decision has ended, so a choice on it can no longer be carried out. Add a standing rule in Permissions and safety, Rules ("add a rule").'); } catch { /* already answered */ }
    }
    posted.clear();
  };
}
