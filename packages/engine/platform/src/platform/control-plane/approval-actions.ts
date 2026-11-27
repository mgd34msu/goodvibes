/**
 * approval-actions.ts, the one port routes, the owner inbox and the event
 * stream read and act on approvals through, and the viewer each reading is
 * computed for.
 *
 * Every row carries the record and its reading for the viewer who asked
 * (approval-lifecycle.ts `readApproval`): an agent reads the same states, the
 * same deadline and the same receipt as the owner, but its allowed actions
 * never include approving or denying. Every action names the revision it acted
 * on and comes back with the current reading, applied or not, so a stale
 * action is refused with what is true now instead of a bare error.
 *
 * It reads this node's broker and, in a group, the other members' approvals
 * through the relay (approval-relay.ts): an id written `<id>@<node>` names
 * another node's approval, and an action on it is relayed to that node, which
 * alone decides it.
 *
 * Cost: a reading is a pure function of the record (no I/O); an action is the
 * broker's one write.
 */
import type { AskPresentation } from '../permissions/ask-presentation.js';
import type { Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { admitEffects } from '../security/effect-authority.js';
import { keepReachable } from '@goodvibes/engine/daemon-api';
import type { ApprovalActionInput, ApprovalBroker, ApprovalRelayPort, SharedApprovalRecord } from './approval-broker.js';
import type { ResolveSharedApprovalInput } from './approval-broker-owner.js';
import { refusal } from '@goodvibes/engine/errors';
import {
  approvalAdministerRefusal,
  approvalRefusal,
  deviceAnswerRefusal,
  isOpenApprovalStatus,
  parseApprovalRef,
  readApproval,
  type ApprovalReading,
  type ApprovalViewer,
  type TransitionOutcome,
} from './approval-lifecycle.js';

/** One approval as a viewer reads it: the record and what it means for them. */
export interface ApprovalReadingRow {
  readonly record: SharedApprovalRecord;
  readonly reading: ApprovalReading;
  /** What the ask says (permissions/ask-presentation.ts): compact in a list, in full for the read of one record. */
  readonly presentation?: AskPresentation | undefined;
}

/** An action's outcome with the current reading for the same viewer (null only for an unknown id). */
export type ApprovalActionResult = TransitionOutcome & { readonly reading: ApprovalReading | null };

export interface ApprovalActions {
  /** The node these records belong to. */
  readonly homeNode: string;
  /** The viewer an authenticated actor is on this node (no actor: the program acting for the owner). */
  viewerOf(actor: Actor | undefined): ApprovalViewer;
  list(viewer: ApprovalViewer, limit?: number): readonly ApprovalReadingRow[];
  /**
   * The owner inbox's page: records `include` accepts, in the inbox's order
   * (decided or ended time, else raised time, newest first; then id), at most
   * `limit`, local and the group's. Only the page is read for the viewer, so a
   * page costs its own rows however long the history is.
   */
  page?(viewer: ApprovalViewer, options: { readonly limit: number; readonly include: (record: SharedApprovalRecord) => boolean }): readonly ApprovalReadingRow[];
  /** One record by id or `<id>@<node>`, wherever it ranks. */
  get(ref: string, viewer: ApprovalViewer): ApprovalReadingRow | null;
  claim(ref: string, input: ApprovalActionInput, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
  resolve(ref: string, input: ResolveSharedApprovalInput, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
  cancel(ref: string, input: ApprovalActionInput, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
  /** A wire raiser gives up its hold: leaving an open ask, or confirming it received a decided one. */
  release(ref: string, input: Omit<ApprovalActionInput, 'expectedRevision'> & { readonly holdId?: string | undefined }, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
}

/** The broker surface the port needs; `relay` is set when the daemon is in a group. */
export type ApprovalActionsBroker = Pick<ApprovalBroker, 'homeNode' | 'listApprovals' | 'getApproval' | 'claimApproval' | 'resolveApproval' | 'cancelApproval' | 'releaseApproval'>
  & { readonly relay?: ApprovalRelayPort | null | undefined }
  & Partial<Pick<ApprovalBroker, 'presentationOf' | 'releaseHoldsOfGonePrograms' | 'shownRecord'>>;

/**
 * The viewer an actor is. In-process callers (no actor) are the program
 * acting for the owner. Who may answer and who may claim or cancel come from
 * the effect table, the same rows the routes enforce.
 */
export function approvalViewerOfActor(actor: Actor | undefined, node: string): ApprovalViewer {
  // No actor is nobody: it reads what anyone may and answers nothing. The daemon's own in-process code names itself
  // (the system actor), which is how it reads and acts as the program; nothing is filled in as the owner.
  if (actor === undefined) {
    return { kind: 'operator', scopes: [], node, mayAnswer: false, mayAdminister: false };
  }
  const kind: ApprovalViewer['kind'] = actor.agentFor !== undefined ? 'agent'
    : actor.class === 'peer' ? 'remote-node'
      : actor.class === 'owner' || actor.class === 'system' ? 'owner-route'
        : actor.class === 'admin' ? 'admin' : 'operator';
  // The owner's own device (an admin that is never the owner himself) answers, but only a question another caller
  // raised: never its own, nor one of a credential made from it (approval-lifecycle.ts `answersOthersOnly`).
  const device = actor.agentFor === undefined && actor.class === 'admin' ? actor.ownerDevice : undefined;
  return {
    kind,
    id: actor.id,
    scopes: actor.scopes === 'all' ? ['*'] : [...actor.scopes],
    node,
    mayAnswer: admitEffects(actor, ['approval.answer']).kind === 'allowed' || device !== undefined,
    mayAdminister: admitEffects(actor, ['approvals.administer']).kind === 'allowed',
    ...(device !== undefined ? { answersOthersOnly: { self: actor.id, madeFromIt: device.madeFromIt } } : {}),
  };
}

/**
 * The port over this node's broker, and, when the daemon is in a group, the
 * other members' approvals through the relay: listed from their summaries
 * (with `homeReachable` from when each was last heard), and acted on by
 * relaying the action to the node that owns it, which decides.
 */
export function localApprovalActions(broker: ApprovalActionsBroker, now: () => number = Date.now): ApprovalActions {
  const row = (stored: SharedApprovalRecord, viewer: ApprovalViewer, full = false): ApprovalReadingRow => {
    // As shown now: an open question's asker by the name it has now (a renamed device; an unpaired one keeps its name).
    const record = broker.shownRecord?.(stored) ?? stored;
    const presentation = broker.presentationOf?.(stored, full);
    return { record, reading: readApproval(record, viewer, now()), ...(presentation ? { presentation } : {}) };
  };
  const remoteRow = (record: SharedApprovalRecord, viewer: ApprovalViewer, relay: ApprovalRelayPort): ApprovalReadingRow =>
    ({ record, reading: readApproval(record, viewer, now(), relay.reachable(record.homeNode)) });
  const parse = (ref: string) => parseApprovalRef(ref, broker.homeNode);
  const elsewhere = (ref: string): ApprovalActionResult => ({
    applied: false,
    record: null,
    reading: null,
    refusal: approvalRefusal('UNKNOWN_APPROVAL', null, `${ref} belongs to another node, and this node is in no group that reaches it.`),
  });
  const withReading = (outcome: TransitionOutcome, viewer: ApprovalViewer): ApprovalActionResult => ({
    ...outcome,
    reading: outcome.record ? readApproval(outcome.record, viewer, now()) : null,
  });
  /** An action on another node's approval goes to that node; a release is the home node's raisers' own. */
  const relayed = async (ref: string, input: { readonly expectedRevision: number | undefined; readonly reason?: string | undefined; readonly note?: string | undefined; readonly selectedHunks?: readonly number[] | undefined;
    readonly remember?: boolean | undefined; readonly rememberTier?: ResolveSharedApprovalInput['rememberTier'] },
    action: 'claim' | 'approve' | 'deny' | 'amend' | 'cancel', viewer: ApprovalViewer): Promise<ApprovalActionResult> => {
    const parsed = parse(ref);
    const relay = broker.relay;
    if (!relay || input.expectedRevision === undefined) return elsewhere(ref);
    return relay.forward(parsed.node, parsed.id, {
      action, expectedRevision: input.expectedRevision,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.selectedHunks !== undefined ? { selectedHunks: input.selectedHunks } : {}),
      // Remembering travels with the answer, so the owning node keeps the rule (or refuses it) as a local answer would.
      ...(input.remember !== undefined ? { remember: input.remember } : {}),
      ...(input.rememberTier !== undefined ? { rememberTier: input.rememberTier } : {}),
    }, viewer);
  };
  const local = (ref: string): string | null => {
    const parsed = parse(ref);
    return parsed.node === broker.homeNode ? parsed.id : null;
  };
  /**
   * The reading's own claim and cancel rule, enforced here where every route
   * passes, locally and before anything is relayed: refused with the current
   * reading when the viewer may not, else null. A record this node cannot read
   * goes on to the broker or the relay, which answer for it.
   */
  const administerRefusal = (ref: string, viewer: ApprovalViewer, action: 'claim' | 'cancel'): ApprovalActionResult | null => {
    const parsed = parse(ref);
    const record = parsed.node === broker.homeNode ? broker.getApproval(parsed.id) : broker.relay?.get(parsed.node, parsed.id) ?? null;
    if (!record) return null;
    const refusal = approvalAdministerRefusal(record, viewer, action);
    return refusal ? { applied: false, record, refusal, reading: readApproval(record, viewer, now()) } : null;
  };
  return {
    get homeNode() { return broker.homeNode; },
    viewerOf: (actor) => approvalViewerOfActor(actor, broker.homeNode),
    list: (viewer, limit = 50) => {
      // Read when shown: a question whose program is no longer running is ended (its update follows on the stream).
      void broker.releaseHoldsOfGonePrograms?.().catch(() => undefined);
      // The newest `limit`, and every ask still open however many settled since: a waiting ask is never out of reach.
      const shown = (record: SharedApprovalRecord, index: number): boolean => index < limit || isOpenApprovalStatus(record.status);
      // Only the questions the caller may reach, before the newest `limit` are cut (control-plane/caller-reach.ts).
      const rows = keepReachable(broker.listApprovals(Number.MAX_SAFE_INTEGER), 'approval', (record) => record.id).filter(shown).map((record) => row(record, viewer));
      const relay = broker.relay;
      if (!relay) return rows;
      // This node's own first, then the group's, newest first within each.
      return [...rows, ...keepReachable(relay.remote(), 'approval', (record) => record.id).filter(shown).map((record) => remoteRow(record, viewer, relay))];
    },
    page: (viewer, options) => {
      const relay = broker.relay;
      const time = (record: SharedApprovalRecord): number => record.resolvedAt ?? record.createdAt;
      const candidates: Array<{ readonly record: SharedApprovalRecord; readonly remote: boolean }> = [];
      for (const record of broker.listApprovals(Number.MAX_SAFE_INTEGER)) if (options.include(record)) candidates.push({ record, remote: false });
      for (const record of relay?.remote() ?? []) if (options.include(record)) candidates.push({ record, remote: true });
      candidates.sort((a, b) => time(b.record) - time(a.record) || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));
      return candidates.slice(0, Math.max(0, options.limit)).map(({ record, remote }) =>
        remote && relay ? remoteRow(record, viewer, relay) : row(record, viewer));
    },
    get: (ref, viewer) => {
      const parsed = parse(ref);
      if (parsed.node === broker.homeNode) {
        const record = broker.getApproval(parsed.id);
        return record ? row(record, viewer, true) : null;
      }
      const relay = broker.relay;
      const record = relay?.get(parsed.node, parsed.id);
      return relay && record ? remoteRow(record, viewer, relay) : null;
    },
    claim: async (ref, input, viewer) => {
      const refused = administerRefusal(ref, viewer, 'claim');
      if (refused) return refused;
      const id = local(ref);
      return id === null ? relayed(ref, input, 'claim', viewer) : withReading(await broker.claimApproval(id, input), viewer);
    },
    resolve: async (ref, input, viewer) => {
      const id = local(ref);
      // The owner's own device answers only a question some other caller raised (approval-lifecycle.ts).
      const record = id !== null && viewer.answersOthersOnly !== undefined ? broker.getApproval(id) : null;
      const own = record ? deviceAnswerRefusal(record, viewer) : undefined;
      if (record && own) {
        return { applied: false, record, reading: readApproval(record, viewer, now()),
          refusal: refusal({ code: own.code, state: `${record.status} (revision ${record.revision})`, status: 403, reason: own.reason,
            next: ['The owner answers it himself, in his signed-in session or his own program.'] }) };
      }
      if (id !== null) return withReading(await broker.resolveApproval(id, input), viewer);
      // Only hunk indexes travel; changed arguments are computed by the node that owns the ask.
      if (input.modifiedArgs !== undefined && input.selectedHunks === undefined) {
        return { applied: false, record: null, reading: null, refusal: approvalRefusal('ILLEGAL_TRANSITION', null,
          'Changed arguments cannot be relayed to the node that owns this approval; approve the whole request or select hunks.') };
      }
      return relayed(ref, input, input.approved ? 'approve' : input.disposition === 'amended' ? 'amend' : 'deny', viewer);
    },
    cancel: async (ref, input, viewer) => {
      const refused = administerRefusal(ref, viewer, 'cancel');
      if (refused) return refused;
      const id = local(ref);
      return id === null ? relayed(ref, input, 'cancel', viewer) : withReading(await broker.cancelApproval(id, input), viewer);
    },
    release: async (ref, input, viewer) => {
      const id = local(ref);
      return id === null ? elsewhere(ref) : withReading(await broker.releaseApproval(id, input), viewer);
    },
  };
}
