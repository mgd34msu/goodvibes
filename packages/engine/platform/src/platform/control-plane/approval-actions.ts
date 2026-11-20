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
 * This is the local implementation: the records of this node's broker. An id
 * written `<id>@<node>` for another node is answered as unknown here; the
 * cross-node relay supplies the implementation that forwards it.
 *
 * Cost: a reading is a pure function of the record (no I/O); an action is the
 * broker's one write.
 */
import type { Actor } from '@goodvibes-jev/engine/daemon-api/http-policy';
import { admitEffects } from '../security/effect-authority.js';
import type { ApprovalActionInput, ApprovalBroker, SharedApprovalRecord } from './approval-broker.js';
import type { ResolveSharedApprovalInput } from './approval-broker-owner.js';
import {
  approvalRefusal,
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
}

/** An action's outcome with the current reading for the same viewer (null only for an unknown id). */
export type ApprovalActionResult = TransitionOutcome & { readonly reading: ApprovalReading | null };

export interface ApprovalActions {
  /** The node these records belong to. */
  readonly homeNode: string;
  /** The viewer an authenticated actor is on this node (no actor: the program acting for the owner). */
  viewerOf(actor: Actor | undefined): ApprovalViewer;
  list(viewer: ApprovalViewer, limit?: number): readonly ApprovalReadingRow[];
  /** One record by id or `<id>@<node>`, wherever it ranks. */
  get(ref: string, viewer: ApprovalViewer): ApprovalReadingRow | null;
  claim(ref: string, input: ApprovalActionInput, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
  resolve(ref: string, input: ResolveSharedApprovalInput, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
  cancel(ref: string, input: ApprovalActionInput, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
  /** A wire raiser gives up its hold: leaving an open ask, or confirming it received a decided one. */
  release(ref: string, input: Omit<ApprovalActionInput, 'expectedRevision'> & { readonly holdId?: string | undefined }, viewer: ApprovalViewer): Promise<ApprovalActionResult>;
}

/** The broker surface the local port needs. */
export type ApprovalActionsBroker = Pick<ApprovalBroker, 'homeNode' | 'listApprovals' | 'getApproval' | 'claimApproval' | 'resolveApproval' | 'cancelApproval' | 'releaseApproval'>;

/**
 * The viewer an actor is. In-process callers (no actor) are the program
 * acting for the owner. Who may answer and who may claim or cancel come from
 * the effect table, the same rows the routes enforce.
 */
export function approvalViewerOfActor(actor: Actor | undefined, node: string): ApprovalViewer {
  if (actor === undefined) {
    return { kind: 'owner-route', scopes: ['*'], node, mayAnswer: true, mayAdminister: true };
  }
  const kind: ApprovalViewer['kind'] = actor.agentFor !== undefined ? 'agent'
    : actor.class === 'peer' ? 'remote-node'
      : actor.class === 'owner' || actor.class === 'system' ? 'owner-route'
        : actor.class === 'admin' ? 'admin' : 'operator';
  return {
    kind,
    id: actor.id,
    scopes: actor.scopes === 'all' ? ['*'] : [...actor.scopes],
    node,
    mayAnswer: admitEffects(actor, ['approval.answer']).kind === 'allowed',
    mayAdminister: admitEffects(actor, ['approvals.administer']).kind === 'allowed',
  };
}

/** The port over this node's broker. */
export function localApprovalActions(broker: ApprovalActionsBroker, now: () => number = Date.now): ApprovalActions {
  const row = (record: SharedApprovalRecord, viewer: ApprovalViewer): ApprovalReadingRow => ({ record, reading: readApproval(record, viewer, now()) });
  const localId = (ref: string): string | null => {
    const parsed = parseApprovalRef(ref, broker.homeNode);
    return parsed.node === broker.homeNode ? parsed.id : null;
  };
  const elsewhere = (ref: string): ApprovalActionResult => ({
    applied: false,
    record: null,
    reading: null,
    refusal: approvalRefusal('UNKNOWN_APPROVAL', null, `${ref} belongs to another node; this node decides only its own approvals.`),
  });
  const withReading = (outcome: TransitionOutcome, viewer: ApprovalViewer): ApprovalActionResult => ({
    ...outcome,
    reading: outcome.record ? readApproval(outcome.record, viewer, now()) : null,
  });
  return {
    get homeNode() { return broker.homeNode; },
    viewerOf: (actor) => approvalViewerOfActor(actor, broker.homeNode),
    list: (viewer, limit = 50) => broker.listApprovals(limit).map((record) => row(record, viewer)),
    get: (ref, viewer) => {
      const id = localId(ref);
      const record = id === null ? null : broker.getApproval(id);
      return record ? row(record, viewer) : null;
    },
    claim: async (ref, input, viewer) => {
      const id = localId(ref);
      return id === null ? elsewhere(ref) : withReading(await broker.claimApproval(id, input), viewer);
    },
    resolve: async (ref, input, viewer) => {
      const id = localId(ref);
      return id === null ? elsewhere(ref) : withReading(await broker.resolveApproval(id, input), viewer);
    },
    cancel: async (ref, input, viewer) => {
      const id = localId(ref);
      return id === null ? elsewhere(ref) : withReading(await broker.cancelApproval(id, input), viewer);
    },
    release: async (ref, input, viewer) => {
      const id = localId(ref);
      return id === null ? elsewhere(ref) : withReading(await broker.releaseApproval(id, input), viewer);
    },
  };
}
