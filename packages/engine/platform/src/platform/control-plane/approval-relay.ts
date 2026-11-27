/**
 * approval-relay.ts, approvals across the machines of one group: the home node
 * decides; the other nodes read a summary and relay a decision to it.
 *
 * Nothing about an approval is replicated as state. The home node's broker is
 * the only owner of each record. Every other member holds a read-only index of
 * summaries, replaced by `sequence`, fed by one `APPROVAL_STATE` datagram per
 * write and by a snapshot when a member is heard after silence or a gap in
 * its write counter shows something was missed. Nothing polls.
 *
 * A decision taken on node B for an approval of node A travels as
 * `APPROVAL_DECIDE` to A, resent at 0.5, 1 and 2 s until A answers or 5 s
 * pass. A applies it through its own broker, the same transition path a local
 * decision takes, with the actor `<person>@<B>` and the request id on the
 * decision (an answer) or on the audit entry it writes (a claim or cancel): a
 * resend that arrives while the first apply runs waits for it and answers with
 * its outcome, and one that arrives after it is recognised by that id on the
 * record and answered "applied", so an action applies once. With no answer
 * in 5 s B reports `NODE_UNREACHABLE` with state `unknown`, never failed or
 * done.
 *
 * What A checks, whatever B says: the sender is a current member whose
 * identity signature verified (group-tenants.ts); the person B vouches for
 * holds write:approvals and, to answer, may answer on B (owner decision D1: a
 * member vouches for its own signed-in people); an approve of an ask that
 * needs the owner's own decision is refused (`OWNER_DECISION_REQUIRED`; that
 * capability is in-process on A and never relayed); an amendment carries no
 * changed arguments, only hunk indexes, from which A computes the edit itself.
 *
 * What crosses the wire is a summary: never the request's arguments, never a
 * withheld answer, never metadata beyond who raised it.
 *
 * Cost: no file, SQL or model request. One datagram per approval write,
 * one snapshot exchange per member heard after silence or per gap, one to four
 * datagrams per relayed decision. Outside a group nothing is sent.
 */
import { randomUUID } from 'node:crypto';
import type { ClusterEnvelope } from '../cluster/protocol-envelope.js';
import type { GroupTenantHost } from '../cluster/group-tenants.js';
import { logger } from '../utils/logger.js';
import { REMEMBER_TIER_VALUES, type RememberTier } from '../permissions/approval-rules.js';
import type { ApprovalActionInput, ApprovalBroker, SharedApprovalRecord } from './approval-broker.js';
import type { ResolveSharedApprovalInput } from './approval-broker-owner.js';
import {
  approvalAdministerRefusal,
  approvalRefusal,
  deviceAnswerRefusal,
  formatApprovalRef,
  isOpenApprovalStatus,
  readApproval,
  type ApprovalAction,
  type ApprovalReading,
  type ApprovalViewer,
  type TransitionOutcome,
} from './approval-lifecycle.js';
import { refusal, type Refusal } from '@goodvibes/engine/errors';

export const APPROVAL_RELAY_TYPES = {
  state: 'APPROVAL_STATE',
  snapshotRequest: 'APPROVAL_SNAPSHOT_REQUEST',
  snapshot: 'APPROVAL_SNAPSHOT',
  decide: 'APPROVAL_DECIDE',
  decideResult: 'APPROVAL_DECIDE_RESULT',
} as const;

/** Closed approvals a snapshot carries besides every open one. */
const SNAPSHOT_CLOSED = 20;
/** Summaries per snapshot datagram, well under the 32 KB envelope. */
const SNAPSHOT_CHUNK = 10;
/** Metadata a summary keeps: who raised it, for "you asked". */
const SUMMARY_METADATA = ['raisedByPrincipal', 'raisedBySurface', 'raisedVia'] as const;

/** What crosses the wire for one approval: the record without the request's arguments and with only its closing audit entry. */
export type ApprovalSummary = SharedApprovalRecord;

/** Who B vouches for when it relays a decision. */
export interface RelayPrincipal {
  readonly node: string;
  readonly id: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly mayAnswer: boolean;
  /** May claim and cancel (`approvals.administer`); absent from a node of 3.3.4 or earlier, whose own gate already required it. */
  readonly mayAdminister?: boolean | undefined;
  /** For the owner's own device: it answers only a question another caller raised (approval-lifecycle.ts). */
  readonly answersOthersOnly?: { readonly self: string; readonly madeFromIt: readonly string[] } | undefined;
}

export type RelayedAction = Exclude<ApprovalAction, never>;

export interface RelayedDecisionInput {
  readonly action: RelayedAction;
  readonly expectedRevision: number;
  readonly reason?: string | undefined;
  readonly note?: string | undefined;
  readonly selectedHunks?: readonly number[] | undefined;
  /** An answer that keeps itself: the home node saves the rule before it records the answer, as for a local one. */
  readonly remember?: boolean | undefined;
  readonly rememberTier?: RememberTier | undefined;
}

/** A relayed action's outcome on B: the home node's outcome, or NODE_UNREACHABLE. */
export type RelayedOutcome = TransitionOutcome & { readonly reading: ApprovalReading | null };

/** The broker surface the relay needs. */
export type ApprovalRelayBroker = Pick<ApprovalBroker, 'homeNode' | 'listApprovals' | 'getApproval' | 'claimApproval' | 'resolveApproval' | 'cancelApproval' | 'subscribe'>;

export interface ApprovalRelayOptions {
  readonly decideTimeoutMs?: number | undefined;
  readonly resendMs?: readonly number[] | undefined;
  readonly now?: (() => number) | undefined;
}

function summarize(record: SharedApprovalRecord): ApprovalSummary {
  const metadata: Record<string, unknown> = {};
  for (const key of SUMMARY_METADATA) if (record.metadata[key] !== undefined) metadata[key] = record.metadata[key];
  const closing = [...record.audit].reverse().find((entry) => entry.action === record.status);
  const { modifiedArgs: _modifiedArgs, ...decision } = record.decision ?? { approved: false };
  return {
    ...record,
    request: { ...record.request, args: {} },
    ...(record.decision ? { decision } : {}),
    metadata,
    audit: closing ? [closing] : [],
  };
}

function readSummary(value: unknown): ApprovalSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SharedApprovalRecord>;
  if (typeof record.id !== 'string' || typeof record.homeNode !== 'string' || typeof record.status !== 'string'
    || typeof record.revision !== 'number' || typeof record.sequence !== 'number' || !record.request || !record.requester || !Array.isArray(record.audit)) return null;
  return record as ApprovalSummary;
}

function readRefusal(value: unknown): Refusal | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body['code'] !== 'string' || typeof body['reason'] !== 'string') return null;
  return refusal({ code: body['code'], state: typeof body['state'] === 'string' ? body['state'] : 'unchanged', reason: body['reason'],
    next: Array.isArray(body['next']) ? body['next'].filter((step): step is string => typeof step === 'string') : [],
    ...(typeof body['status'] === 'number' ? { status: body['status'] } : {}) });
}

function holdsWriteApprovals(scopes: readonly string[]): boolean {
  return scopes.includes('*') || scopes.includes('write:approvals');
}

export class ApprovalRelay {
  readonly #host: GroupTenantHost;
  readonly #broker: ApprovalRelayBroker;
  readonly #now: () => number;
  readonly #decideTimeoutMs: number;
  readonly #resendMs: readonly number[];
  /** This boot of this node's approval writes: a receiver that sees a gap (or a new boot) asks for a snapshot. */
  readonly #boot = randomUUID();
  #setRevision = 0;
  /** Other nodes' summaries, by node then id; replaced by sequence. */
  readonly #remote = new Map<string, Map<string, ApprovalSummary>>();
  /** The last write counter heard from each node, and its boot. */
  readonly #heard = new Map<string, { readonly boot: string; readonly setRevision: number }>();
  /** Relayed decisions waiting for the home node's answer. */
  readonly #waiting = new Map<string, (result: Record<string, unknown>) => void>();
  /** On the home node: relayed actions being applied, by sending node and request id, for the length of the apply. */
  readonly #applying = new Map<string, Promise<RelayApplyOutcome>>();
  readonly #stops: (() => void)[] = [];

  constructor(host: GroupTenantHost, broker: ApprovalRelayBroker, options: ApprovalRelayOptions = {}) {
    this.#host = host;
    this.#broker = broker;
    this.#now = options.now ?? Date.now;
    this.#decideTimeoutMs = options.decideTimeoutMs ?? 5_000;
    this.#resendMs = options.resendMs ?? [500, 1_000, 2_000];
    this.#stops.push(host.register({
      types: Object.values(APPROVAL_RELAY_TYPES),
      handle: (envelope, from) => this.#handle(envelope, from.nodeId),
    }));
    // Every write of an approval this node owns goes to the group as one summary.
    this.#stops.push(broker.subscribe((record) => {
      if (record.homeNode !== broker.homeNode) return;
      this.#setRevision += 1;
      void host.send(APPROVAL_RELAY_TYPES.state, { boot: this.#boot, setRevision: this.#setRevision, summary: summarize(record) })
        .catch((error: unknown) => logger.debug('[approvals] the approval state could not be sent to the group', { error: String(error) }));
    }));
    // A member heard after silence (a start, a join, a return): ask it for what it holds.
    this.#stops.push(host.onMemberHeard((nodeId) => { void this.#requestSnapshot(nodeId); }));
  }

  close(): void {
    for (const stop of this.#stops.splice(0)) stop();
    for (const settle of this.#waiting.values()) settle({ timedOut: true });
    this.#waiting.clear();
  }

  /** Whether the node that owns `node`'s approvals is a current member heard recently. */
  reachable(node: string): boolean {
    const heard = this.#host.lastHeardFrom(node);
    return this.#host.isCurrentMember(node) && heard !== null && this.#now() - heard <= this.#host.silenceMs;
  }

  /** Summaries of other current members' approvals, newest sequence per approval. */
  remote(): readonly ApprovalSummary[] {
    const rows: ApprovalSummary[] = [];
    for (const [node, summaries] of this.#remote) {
      // A removed member's approvals are dropped with it.
      if (!this.#host.isCurrentMember(node)) { this.#remote.delete(node); this.#heard.delete(node); continue; }
      rows.push(...summaries.values());
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  /** One remote summary. */
  get(node: string, id: string): ApprovalSummary | null {
    if (!this.#host.isCurrentMember(node)) return null;
    return this.#remote.get(node)?.get(id) ?? null;
  }

  /**
   * Act on an approval whose home is another node. Resolves with that node's
   * outcome, or NODE_UNREACHABLE (state `unknown`) when it did not answer.
   */
  async forward(node: string, id: string, input: RelayedDecisionInput, viewer: ApprovalViewer): Promise<RelayedOutcome> {
    // A viewer the daemon cannot name is nobody: the relay never names the owner (or anyone) on its own.
    if (viewer.id === undefined || viewer.id === '') {
      const known = this.get(node, id);
      return { applied: false, record: known, reading: known ? readApproval(known, viewer, this.#now(), false) : null,
        refusal: refusal({ code: 'FORBIDDEN', state: known?.status ?? 'unknown', status: 403,
          reason: `${formatApprovalRef({ node, id })} was not acted on: the daemon could not name who is acting, and another node is never told someone acted when nobody it can name did.`,
          next: ['Act on it from a credential the daemon names (your sign-in, your program, your device).'] }) };
    }
    const requestId = randomUUID();
    const principal: RelayPrincipal = { node: this.#host.selfNode, id: viewer.id, kind: viewer.kind, scopes: viewer.scopes, mayAnswer: viewer.mayAnswer, mayAdminister: viewer.mayAdminister,
      // The owner's own device answers only another caller's question: the owning node holds it to that too.
      ...(viewer.answersOthersOnly ? { answersOthersOnly: { self: viewer.answersOthersOnly.self, madeFromIt: [...viewer.answersOthersOnly.madeFromIt] } } : {}) };
    const body = { requestId, id, principal, ...input, ...(input.selectedHunks ? { selectedHunks: [...input.selectedHunks] } : {}) };
    const answered = new Promise<Record<string, unknown>>((resolve) => { this.#waiting.set(requestId, resolve); });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const send = (): void => { void this.#host.send(APPROVAL_RELAY_TYPES.decide, body, node).catch(() => undefined); };
    send();
    for (const delay of this.#resendMs) { const timer = setTimeout(send, delay); timer.unref?.(); timers.push(timer); }
    const deadline = new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), this.#decideTimeoutMs);
      timer.unref?.();
      timers.push(timer);
    });
    let result: Record<string, unknown>;
    try {
      result = await Promise.race([answered, deadline]);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      this.#waiting.delete(requestId);
    }
    const known = this.get(node, id);
    if (result['timedOut'] === true) {
      return { applied: false, record: known, reading: known ? readApproval(known, viewer, this.#now(), false) : null,
        refusal: approvalRefusal('NODE_UNREACHABLE', known, `${formatApprovalRef({ node, id })} belongs to a node that did not answer in ${this.#decideTimeoutMs / 1_000} seconds; whether the ${input.action} was applied is not known.`) };
    }
    const summary = readSummary(result['summary']);
    if (summary) this.#remember(summary);
    const reading = summary ? readApproval(summary, viewer, this.#now(), true) : null;
    if (result['applied'] === true && summary) return { applied: true, record: summary, reading };
    return { applied: false, record: summary, reading, refusal: readRefusal(result['refusal']) ?? approvalRefusal('UNKNOWN_APPROVAL', summary) };
  }

  async #requestSnapshot(node: string): Promise<void> {
    await this.#host.send(APPROVAL_RELAY_TYPES.snapshotRequest, {}, node).catch(() => undefined);
  }

  #remember(summary: ApprovalSummary): void {
    if (summary.homeNode === this.#broker.homeNode) return;
    let summaries = this.#remote.get(summary.homeNode);
    if (!summaries) { summaries = new Map(); this.#remote.set(summary.homeNode, summaries); }
    const held = summaries.get(summary.id);
    if (held && held.sequence >= summary.sequence) return;
    summaries.set(summary.id, summary);
  }

  async #handle(envelope: ClusterEnvelope, from: string): Promise<void> {
    const body = envelope.body;
    switch (envelope.type) {
      case APPROVAL_RELAY_TYPES.state: {
        const summary = readSummary(body['summary']);
        // A node speaks only for its own approvals.
        if (!summary || summary.homeNode !== from) return;
        this.#remember(summary);
        const boot = typeof body['boot'] === 'string' ? body['boot'] : '';
        const setRevision = typeof body['setRevision'] === 'number' ? body['setRevision'] : 0;
        const heard = this.#heard.get(from);
        this.#heard.set(from, { boot, setRevision });
        if (!heard || heard.boot !== boot || setRevision !== heard.setRevision + 1) await this.#requestSnapshot(from);
        return;
      }
      case APPROVAL_RELAY_TYPES.snapshotRequest: {
        const records = this.#broker.listApprovals(Number.MAX_SAFE_INTEGER).filter((record) => record.homeNode === this.#broker.homeNode);
        const chosen = [...records.filter((record) => isOpenApprovalStatus(record.status)),
          ...records.filter((record) => !isOpenApprovalStatus(record.status)).slice(0, SNAPSHOT_CLOSED)].map(summarize);
        const parts = Math.max(1, Math.ceil(chosen.length / SNAPSHOT_CHUNK));
        for (let part = 0; part < parts; part += 1) {
          await this.#host.send(APPROVAL_RELAY_TYPES.snapshot, {
            boot: this.#boot, setRevision: this.#setRevision, part, parts,
            summaries: chosen.slice(part * SNAPSHOT_CHUNK, (part + 1) * SNAPSHOT_CHUNK),
          }, from);
        }
        return;
      }
      case APPROVAL_RELAY_TYPES.snapshot: {
        const summaries = Array.isArray(body['summaries']) ? body['summaries'] : [];
        for (const value of summaries) {
          const summary = readSummary(value);
          if (summary && summary.homeNode === from) this.#remember(summary);
        }
        if (typeof body['boot'] === 'string' && typeof body['setRevision'] === 'number') {
          this.#heard.set(from, { boot: body['boot'], setRevision: body['setRevision'] });
        }
        return;
      }
      case APPROVAL_RELAY_TYPES.decide:
        await this.#decide(body, from);
        return;
      case APPROVAL_RELAY_TYPES.decideResult: {
        const requestId = body['requestId'];
        if (typeof requestId === 'string') this.#waiting.get(requestId)?.(body);
        return;
      }
    }
  }

  /**
   * On the home node: apply a relayed decision through this broker's own
   * transition path, once per request id. A resend that arrives while the
   * first apply is still running waits for that apply and answers with its
   * outcome; one that arrives after it is recognised on the record.
   */
  async #decide(body: Record<string, unknown>, from: string): Promise<void> {
    const requestId = typeof body['requestId'] === 'string' ? body['requestId'] : null;
    const id = typeof body['id'] === 'string' ? body['id'] : null;
    if (!requestId || !id) return;
    const key = `${from}\u0000${requestId}`;
    let applying = this.#applying.get(key);
    if (!applying) {
      // Set before the apply's first await, so a resend arriving meanwhile finds it.
      applying = this.#apply(body, requestId, id, from);
      this.#applying.set(key, applying);
      const started = applying;
      void started.finally(() => { if (this.#applying.get(key) === started) this.#applying.delete(key); }).catch(() => undefined);
    }
    const outcome = await applying;
    await this.#host.send(APPROVAL_RELAY_TYPES.decideResult, {
      requestId, applied: outcome.applied,
      ...(outcome.record ? { summary: summarize(outcome.record) } : {}),
      ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
    }, from);
  }

  async #apply(body: Record<string, unknown>, requestId: string, id: string, from: string): Promise<RelayApplyOutcome> {
    const principal = (body['principal'] ?? {}) as Partial<RelayPrincipal>;
    const action = body['action'] as RelayedAction;
    const expectedRevision = typeof body['expectedRevision'] === 'number' ? body['expectedRevision'] : undefined;
    const record = this.#broker.getApproval(id);
    if (!record) return { applied: false, record: null, refusal: approvalRefusal('UNKNOWN_APPROVAL', null) };
    // A resend of an action this node already applied is that action, applied once: an answer carries the
    // request id on its decision, a claim or cancel on the audit entry it wrote.
    if (record.decision?.relayRequestId === requestId
      || record.audit.some((entry) => entry.relayRequestId === requestId && entry.actorNode === from)) {
      return { applied: true, record };
    }
    if (principal.node !== from || typeof principal.id !== 'string' || !Array.isArray(principal.scopes) || !holdsWriteApprovals(principal.scopes)) {
      return { applied: false, record, refusal: refusal({ code: 'FORBIDDEN', state: record.status, status: 403,
        reason: 'The node that relayed this decision did not vouch for a person holding write:approvals.', next: ['Act on it from a credential that holds write:approvals.'] }) };
    }
    const answering = action === 'approve' || action === 'deny' || action === 'amend';
    if (answering && principal.mayAnswer !== true) {
      return { applied: false, record, refusal: refusal({ code: 'OWNER_ONLY', state: record.status, status: 403,
        reason: 'Answering an approval is the owner\'s own act; the person this decision was relayed for may not answer it.', next: ['The owner answers it.'] }) };
    }
    const othersOnly = principal.answersOthersOnly;
    if (answering && othersOnly !== undefined) {
      const madeFromIt = Array.isArray(othersOnly.madeFromIt) ? othersOnly.madeFromIt.filter((one): one is string => typeof one === 'string') : [];
      const own = deviceAnswerRefusal(record, { answersOthersOnly: { self: String(othersOnly.self), madeFromIt } });
      if (own) return { applied: false, record, refusal: refusal({ code: own.code, state: record.status, status: 403, reason: own.reason, next: ['The owner answers it.'] }) };
    }
    if (action === 'claim' || action === 'cancel') {
      // The same claim and cancel rule a local action is held to (approval-actions.ts), for the person the
      // relaying node vouches for: an agent never claims, and cancels only what it raised on this node.
      const viewer: ApprovalViewer = {
        kind: principal.kind === 'agent' ? 'agent' : 'remote-node',
        id: `${principal.id}`,
        scopes: principal.scopes ?? [],
        node: from,
        mayAnswer: principal.mayAnswer === true,
        mayAdminister: principal.mayAdminister !== false,
      };
      const refused = approvalAdministerRefusal(record, viewer, action);
      if (refused) return { applied: false, record, refusal: refused };
    }
    const rememberTier = body['rememberTier'];
    if (rememberTier !== undefined && !(typeof rememberTier === 'string' && (REMEMBER_TIER_VALUES as readonly string[]).includes(rememberTier))) {
      return { applied: false, record, refusal: refusal({ code: 'INVALID_ARGUMENT', state: record.status, status: 400,
        reason: `rememberTier must be one of: ${REMEMBER_TIER_VALUES.join(', ')}.`, next: ['Answer it again with one of those tiers, or without remembering.'] }) };
    }
    const actor: ApprovalActionInput = {
      actor: `${principal.id}@${from}`, actorSurface: `node:${from}`, actorNode: from,
      ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
      expectedRevision,
      relayRequestId: requestId,
    };
    let outcome: TransitionOutcome;
    try {
      if (action === 'claim') outcome = await this.#broker.claimApproval(id, actor);
      else if (action === 'cancel') outcome = await this.#broker.cancelApproval(id, actor);
      else {
        const selectedHunks = Array.isArray(body['selectedHunks']) && body['selectedHunks'].every((index) => Number.isInteger(index)) ? body['selectedHunks'] as number[] : undefined;
        const input: ResolveSharedApprovalInput = {
          ...actor,
          approved: action === 'approve',
          disposition: action === 'approve' ? 'approved' : action === 'amend' ? 'amended' : 'denied',
          ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
          ...(action === 'approve' && selectedHunks ? { selectedHunks } : {}),
          ...(typeof body['remember'] === 'boolean' ? { remember: body['remember'] } : {}),
          ...(rememberTier !== undefined ? { rememberTier: rememberTier as RememberTier } : {}),
        };
        outcome = await this.#broker.resolveApproval(id, input);
      }
    } catch (error) {
      // The broker's own code travels back (REMEMBER_NOT_SAVED, APPROVED_NOT_APPLIED, INVALID_ARGUMENT), as a local answer would show it.
      // An error without a code of its own is answered as NOT_APPLIED (400).
      const tagged = (error ?? {}) as { readonly code?: unknown; readonly status?: unknown };
      const notApplied = { code: 'NOT_APPLIED', status: 400, state: record.status,
        reason: error instanceof Error ? error.message : String(error), next: ['Read the approval again.'] };
      return { applied: false, record: this.#broker.getApproval(id), refusal: refusal({
        ...notApplied,
        ...(typeof tagged.code === 'string' ? { code: tagged.code } : {}),
        ...(typeof tagged.status === 'number' ? { status: tagged.status } : {}),
      }) };
    }
    return outcome.applied ? { applied: true, record: outcome.record } : { applied: false, record: outcome.record, refusal: outcome.refusal };
  }
}

/** What the home node answers a relayed action with. */
interface RelayApplyOutcome {
  readonly applied: boolean;
  readonly record: SharedApprovalRecord | null;
  readonly refusal?: Refusal | undefined;
}
