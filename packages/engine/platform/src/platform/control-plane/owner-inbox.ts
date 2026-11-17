/**
 * The owner inbox: one list of everything waiting on the owner, answered once,
 * from any surface.
 *
 * It holds two sources behind one shape. Permission asks stay in the approval
 * broker, which already keeps them, settles their waiters and fans them out;
 * the inbox reads them from it and answers them through it. Everything else a
 * subsystem or an agent needs from the owner (a question, a channel claim, a
 * purchase window, an action queued while he was away) is posted here and kept
 * in the question store: one SQLite file in the owner's home that the daemon,
 * both terminal apps and their agents all open (question-store.ts).
 *
 * Each process that asks or answers holds an instance over that one store: the
 * daemon's also reads its approval broker, and the web UI and a terminal that
 * reaches the daemon go through the daemon's (`inbox.*` verbs) so pushes and
 * live updates follow; a terminal with no daemon reads and answers the store
 * itself. The first answer wins in the store, whichever process gives it; a
 * later one changes nothing and is told who answered, from where.
 *
 * An answer goes back to whoever asked, by one rule for every asker (a terminal
 * or headless session, a hosted session, a channel's shared session, an agent):
 * the asker takes it on its next model request while it is open, otherwise when
 * it is next opened, and it is not deliverable only when the asker can never be
 * opened again (deleted). The asker records that it took the answer; who
 * answered is told which of delivered, waiting or not deliverable it is, read
 * from the facts the asker's owner keeps (presence probes, below).
 *
 * Cost: a tool call that queues nothing costs nothing here. A post, an answer,
 * a withdrawal or a delivery is one row write (approvals: the broker's own
 * write). A list re-reads the rows only when the store's revision moved, plus
 * one presence check (a stat, a small file read) per answered question still
 * waiting. `revision()` is one statement over SQLite's change counters.
 */
import { refusal, type Refusal } from '@goodvibes-jev/engine/errors';
import type { ApprovalBroker, SharedApprovalRecord } from './approval-broker.js';
import type { ApprovalActionOutcome } from './approval-broker-owner.js';
import {
  OWNER_ANSWER_AGENT_METADATA,
  OWNER_ANSWER_SESSION_METADATA,
  sharedQuestionStore,
  type QuestionAskerScope,
  type QuestionStore,
  type StoredOwnerEntry,
  type StoredOwnerItem,
  type StoredOwnerItemKind,
} from './question-store.js';
import type { RevisionSource } from '../utils/revision.js';
import { logger } from '../utils/logger.js';
import { askerLivenessPath, isAskerRunning, type OwnerAskerKind } from './owner-asker-liveness.js';

export { OWNER_ANSWER_AGENT_METADATA, OWNER_ANSWER_SESSION_METADATA };

export type OwnerItemKind = 'approval' | 'question' | 'claim' | 'purchase' | 'queued-action';
export type OwnerItemStatus = 'open' | 'answered' | 'withdrawn' | 'expired';

/** An answer: one of the item's options, or free text when it has none. Text may accompany an option. */
export interface OwnerAnswer {
  readonly option?: string | undefined;
  readonly text?: string | undefined;
}

/** Who answered and from where. Taken from the authenticated request, never from the answer body. */
export interface OwnerAnswerSource {
  readonly actor: string;
  readonly surface: string;
}

export interface OwnerItem {
  readonly id: string;
  readonly kind: OwnerItemKind;
  readonly status: OwnerItemStatus;
  readonly sessionId?: string | undefined;
  readonly title: string;
  readonly detail: string;
  /** Empty: answer with free text. */
  readonly options: readonly string[];
  readonly askedBy?: string | undefined;
  readonly createdAt: number;
  readonly expiresAt?: number | undefined;
  readonly answer?: OwnerAnswer | undefined;
  readonly answeredBy?: OwnerAnswerSource | undefined;
  /** When it stopped being open: answered, withdrawn or (for approvals) cancelled or expired. */
  readonly closedAt?: number | undefined;
  /** Why a withdrawn item was taken back. */
  readonly withdrawnReason?: string | undefined;
  readonly key?: string | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
  /** For an answered question with an asker: whether the answer reached it, waits for it, or cannot reach it. */
  readonly delivery?: OwnerAnswerDelivery | undefined;
}

/** What a producer posts. Approvals are raised through the approval broker, not posted. */
export interface NewOwnerItem {
  readonly kind: StoredOwnerItemKind;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly options?: readonly string[] | undefined;
  readonly sessionId?: string | undefined;
  readonly askedBy?: string | undefined;
  /** The producer's own name for the item (a purchase window id, a sender). A second post under an open key returns the first item. */
  readonly key?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export interface OwnerInboxListFilter {
  /** `open` (default), `closed` (answered, withdrawn, expired) or `all`. */
  readonly status?: 'open' | 'closed' | 'all' | undefined;
  readonly kinds?: readonly OwnerItemKind[] | undefined;
  readonly sessionId?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * What became of an answer: `delivered` (the asker is open and takes it on its
 * next model request, or has taken it), `waiting` (kept on the question until
 * the asker is next opened), `undeliverable` (the asker was deleted or can
 * never be opened again; `reason` says which). The answer stays on the item in
 * every state.
 */
export type OwnerAnswerDeliveryState = 'delivered' | 'waiting' | 'undeliverable';

export interface OwnerAnswerDelivery {
  readonly state: OwnerAnswerDeliveryState;
  /** Who the answer went to, or is meant for ("agent …", "session …"). */
  readonly to: string;
  /** For `waiting` and `undeliverable`: what happens next, or why it cannot arrive. */
  readonly reason?: string | undefined;
}

/**
 * Metadata key saying which process keeps the asker: `hosted` for a hosted
 * session and `daemon` for an agent the daemon runs (including a channel's
 * turn). Absent: a terminal app's session (TUI, Agent, headless).
 */
export const OWNER_ASKER_HOST_METADATA = 'askerHost';
/** Metadata key holding the asking terminal session's saved file: present = it can be opened again. */
export const OWNER_ASKER_SESSION_FILE_METADATA = 'askerSessionFile';

/** Who asked a question and where the facts about it are kept, read from the item. */
export interface OwnerAsker {
  /** The session the answer goes back to. */
  readonly session?: string | undefined;
  /** The agent that asked, when one did; it takes the answer while it runs. */
  readonly agent?: string | undefined;
  readonly host?: 'hosted' | 'daemon' | undefined;
  readonly sessionFile?: string | undefined;
}

/**
 * Whether the asker is open right now (`attached`), can be opened again but is
 * not open (`closed`, with what reopens it), or can never be opened again
 * (`gone`, with why).
 */
export type OwnerAskerPresence =
  | { readonly state: 'attached' | 'closed'; readonly title?: string | undefined; readonly reopens?: string | undefined }
  | { readonly state: 'gone'; readonly reason: string };

/**
 * Says where an asker is. `running` is the one liveness fact every kind of
 * asker shares: some process on this machine holds the asker's lock
 * (owner-asker-liveness.ts). The probe adds what its owner knows (a terminal
 * session's saved file, the daemon's hosted sessions, agents and session
 * broker) to tell closed from gone. Undefined: not this probe's kind of asker.
 */
export type OwnerAskerPresenceProbe = (asker: OwnerAsker, running: boolean) => OwnerAskerPresence | undefined;

/** What the asking side reports about an answer it took (`delivered`) or can never take (`undeliverable`). */
export interface OwnerAnswerDeliveryReport {
  readonly state: 'delivered' | 'undeliverable';
  readonly reason?: string | undefined;
}

function metadataText(item: Pick<OwnerItem, 'metadata'>, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The session an item's answer goes back to, when a session asked it. */
export function answerSessionOf(item: Pick<OwnerItem, 'metadata'>): string | undefined {
  return metadataText(item, OWNER_ANSWER_SESSION_METADATA);
}

/** The agent that asked an item, when one did. */
export function answerAgentOf(item: Pick<OwnerItem, 'metadata'>): string | undefined {
  return metadataText(item, OWNER_ANSWER_AGENT_METADATA);
}

/** Who asked an item, or undefined when no session or agent did (a claim, a purchase window). */
export function askerOf(item: Pick<OwnerItem, 'metadata'>): OwnerAsker | undefined {
  const session = answerSessionOf(item);
  const agent = answerAgentOf(item);
  if (session === undefined && agent === undefined) return undefined;
  const host = metadataText(item, OWNER_ASKER_HOST_METADATA);
  const sessionFile = metadataText(item, OWNER_ASKER_SESSION_FILE_METADATA);
  return {
    ...(session !== undefined ? { session } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(host === 'hosted' || host === 'daemon' ? { host } : {}),
    ...(sessionFile !== undefined ? { sessionFile } : {}),
  };
}

function askerLabel(asker: OwnerAsker, presence: OwnerAskerPresence | undefined): string {
  if (asker.session === undefined) return `agent ${asker.agent ?? 'unknown'}`;
  const title = presence && presence.state !== 'gone' ? presence.title?.trim() : undefined;
  const kind = asker.host === 'hosted' ? 'hosted session' : 'session';
  return title ? `${kind} ${asker.session} ("${clip(title, 60)}")` : `${kind} ${asker.session}`;
}

/** What an answer to `asker` becomes now, when the asker has not yet taken it. Read, never written. */
function askerDelivery(asker: OwnerAsker, presence: OwnerAskerPresence): OwnerAnswerDelivery {
  const to = askerLabel(asker, presence);
  if (presence.state === 'gone') return { state: 'undeliverable', to, reason: `${presence.reason} The answer is kept on the question.` };
  if (presence.state === 'attached') return { state: 'delivered', to };
  const reopens = presence.reopens ?? (asker.session !== undefined ? `${to} is next opened` : `${to} runs again`);
  return { state: 'waiting', to, reason: `Saved; it will be delivered when ${reopens}.` };
}

/** The line the asking conversation is given when its question closes. */
export function questionClosedText(item: OwnerItem): string {
  const question = `question ${item.id} ("${item.title}")`;
  if (item.status === 'answered') {
    const parts = [item.answer?.option, item.answer?.text].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    const from = item.answeredBy ? ` from ${item.answeredBy.surface}` : '';
    return `[Owner answer] The owner answered your ${question}${from}: ${parts.length > 0 ? parts.join(' - ') : '(no text)'}`;
  }
  if (item.status === 'withdrawn') return `[Owner answer] Your ${question} was withdrawn${item.withdrawnReason ? `: ${item.withdrawnReason}` : ''}. It will not be answered.`;
  return `[Owner answer] Your ${question} expired unanswered. Decide without it or ask again.`;
}

/**
 * Where a process reads the answers its askers wait for: the one store, read
 * directly. Every call is synchronous, so a conversation can look just before
 * it builds a model request.
 */
export interface OwnerAnswerReader {
  /** Moves when anything in the store changed, in any process. */
  revision(): number;
  get(id: string): OwnerItem | undefined;
  /** One asker's open questions and the answers it has not taken (one indexed read). */
  pendingFor(scope: QuestionAskerScope): readonly OwnerItem[];
  /** Record that the caller took the answer into its conversation. True only for the first taker. */
  claim(id: string): boolean;
  /** The lock file a running asker holds while it waits on a question (owner-asker-liveness.ts). */
  askerLivenessPath(kind: OwnerAskerKind, id: string): string;
}

export type OwnerAnswerOutcome =
  | { readonly applied: true; readonly item: OwnerItem; readonly delivery?: OwnerAnswerDelivery | undefined }
  | { readonly applied: false; readonly item?: OwnerItem | undefined; readonly refusal: Refusal };

export type OwnerPostOutcome =
  | { readonly created: boolean; readonly item: OwnerItem };

export type OwnerInboxListener = (item: OwnerItem) => void;

/** The part of the approval broker the inbox reads and answers through. */
export type OwnerInboxApprovalSource = Pick<ApprovalBroker, 'listApprovals' | 'getApproval' | 'resolveApproval' | 'subscribe'>
  & { readonly eventPublisher?: Pick<NonNullable<ApprovalBroker['eventPublisher']>, 'publishEvent'> | null | undefined };

/**
 * The wire event a question, claim, purchase window or queued action is
 * published on when it is posted, answered, withdrawn or expires by an answer
 * attempt. Approvals keep their own `approval-update`.
 */
export const OWNER_INBOX_UPDATE_WIRE_EVENT = 'owner-inbox-update';

/** What a surface needs to show and answer the inbox, in process or over the wire. */
export interface OwnerInboxPort {
  list(filter?: OwnerInboxListFilter): Promise<readonly OwnerItem[]>;
  /** One item by id, open or closed. */
  find(id: string): Promise<OwnerItem | undefined>;
  answer(id: string, answer: OwnerAnswer): Promise<OwnerAnswerOutcome>;
}

export const OWNER_ITEM_KINDS: readonly OwnerItemKind[] = ['approval', 'question', 'claim', 'purchase', 'queued-action'];
export const OWNER_ITEM_LIMITS = Object.freeze({
  titleChars: 200,
  detailChars: 4000,
  options: 8,
  optionChars: 40,
  answerTextChars: 4000,
  keyChars: 200,
  metadataEntries: 16,
});

const POSTABLE_KINDS: ReadonlySet<string> = new Set<StoredOwnerItemKind>(['question', 'claim', 'purchase', 'queued-action']);
const APPROVE = 'approve';
const DENY = 'deny';
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export class OwnerInboxInputError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = 'OwnerInboxInputError';
    this.field = field;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new OwnerInboxInputError(`${field} must be non-empty text.`, field);
  if (value.length > max) throw new OwnerInboxInputError(`${field} is longer than ${max} characters.`, field);
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requireText(value, field, max);
}

/** Validate a producer's item; the store trusts what it is given. */
export function validateNewOwnerItem(input: NewOwnerItem): Omit<StoredOwnerItem, 'id' | 'createdAt'> {
  if (!POSTABLE_KINDS.has(input.kind)) {
    throw new OwnerInboxInputError('kind must be question, claim, purchase or queued-action; permission asks are raised through approvals.', 'kind');
  }
  const options = input.options ?? [];
  if (!Array.isArray(options) || options.length > OWNER_ITEM_LIMITS.options) {
    throw new OwnerInboxInputError(`options must be a list of at most ${OWNER_ITEM_LIMITS.options} choices.`, 'options');
  }
  const seen = new Set<string>();
  const cleanOptions = options.map((option) => {
    const text = requireText(option, 'options', OWNER_ITEM_LIMITS.optionChars);
    if (/\s/.test(text)) throw new OwnerInboxInputError(`option "${text}" must be one word so it can be typed as an answer.`, 'options');
    if (seen.has(text.toLowerCase())) throw new OwnerInboxInputError(`option "${text}" is listed twice.`, 'options');
    seen.add(text.toLowerCase());
    return text;
  });
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0)) {
    throw new OwnerInboxInputError('expiresAt must be a time in milliseconds.', 'expiresAt');
  }
  let metadata: Record<string, string | number | boolean> | undefined;
  if (input.metadata !== undefined) {
    const entries = Object.entries(input.metadata);
    if (entries.length > OWNER_ITEM_LIMITS.metadataEntries
      || entries.some(([, value]) => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'string' && value.length > 1000))) {
      throw new OwnerInboxInputError(`metadata must hold at most ${OWNER_ITEM_LIMITS.metadataEntries} short text, number or true/false values.`, 'metadata');
    }
    metadata = Object.fromEntries(entries);
  }
  const detail = input.detail === undefined ? '' : input.detail;
  if (typeof detail !== 'string' || detail.length > OWNER_ITEM_LIMITS.detailChars) {
    throw new OwnerInboxInputError(`detail is longer than ${OWNER_ITEM_LIMITS.detailChars} characters.`, 'detail');
  }
  const sessionId = optionalText(input.sessionId, 'sessionId', 200);
  const askedBy = optionalText(input.askedBy, 'askedBy', 200);
  const key = optionalText(input.key, 'key', OWNER_ITEM_LIMITS.keyChars);
  return {
    kind: input.kind,
    title: requireText(input.title, 'title', OWNER_ITEM_LIMITS.titleChars),
    detail,
    options: cleanOptions,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(askedBy !== undefined ? { askedBy } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function storedStatus(entry: StoredOwnerEntry, now: number): OwnerItemStatus {
  if (entry.withdrawnReason !== undefined) return 'withdrawn';
  if (entry.answer !== undefined) return 'answered';
  if (entry.item.expiresAt !== undefined && entry.item.expiresAt <= now) return 'expired';
  return 'open';
}

function storedDelivery(entry: StoredOwnerEntry, presence: (asker: OwnerAsker) => OwnerAskerPresence): OwnerAnswerDelivery | undefined {
  if (entry.answer === undefined) return undefined;
  const asker = askerOf(entry.item);
  if (asker === undefined) return undefined;
  if (entry.delivery) {
    return { state: entry.delivery.state, to: askerLabel(asker, undefined), ...(entry.delivery.reason !== undefined ? { reason: entry.delivery.reason } : {}) };
  }
  return askerDelivery(asker, presence(asker));
}

function projectStored(entry: StoredOwnerEntry, now: number, presence: (asker: OwnerAsker) => OwnerAskerPresence): OwnerItem {
  const { item } = entry;
  const status = storedStatus(entry, now);
  const delivery = storedDelivery(entry, presence);
  return {
    id: item.id,
    kind: item.kind,
    status,
    ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
    title: item.title,
    detail: item.detail,
    options: item.options,
    ...(item.askedBy !== undefined ? { askedBy: item.askedBy } : {}),
    createdAt: item.createdAt,
    ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
    ...(entry.answer !== undefined ? { answer: entry.answer } : {}),
    ...(entry.answeredBy !== undefined ? { answeredBy: entry.answeredBy } : {}),
    ...(entry.closedAt !== undefined ? { closedAt: entry.closedAt }
      : status === 'expired' && item.expiresAt !== undefined ? { closedAt: item.expiresAt } : {}),
    ...(entry.withdrawnReason !== undefined ? { withdrawnReason: entry.withdrawnReason } : {}),
    ...(item.key !== undefined ? { key: item.key } : {}),
    ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
  };
}

function approvalStatus(record: SharedApprovalRecord): OwnerItemStatus {
  switch (record.status) {
    case 'pending':
    case 'claimed':
      return 'open';
    case 'approved':
    case 'denied':
      return 'answered';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'withdrawn';
  }
}

function approvalDetail(record: SharedApprovalRecord): string {
  const { request } = record;
  const lines = [
    `Risk: ${request.analysis.riskLevel}`,
    ...request.analysis.reasons.map((reason) => `- ${reason}`),
    ...(request.workingDirectory ? [`In: ${request.workingDirectory}`] : []),
    ...(record.requiresOwnerDecision ? ['Approve it on the device that raised it; it can be denied from here.'] : []),
  ];
  return clip(lines.join('\n'), OWNER_ITEM_LIMITS.detailChars);
}

/** The last surface named on the approval's audit trail for the action that closed it. */
function approvalClosingSurface(record: SharedApprovalRecord): string {
  for (let index = record.audit.length - 1; index >= 0; index--) {
    const entry = record.audit[index]!;
    if (entry.action === record.status) {
      return entry.actorSurface ?? 'unknown surface';
    }
  }
  return 'unknown surface';
}

function projectApproval(record: SharedApprovalRecord): OwnerItem {
  const status = approvalStatus(record);
  const answered = record.status === 'approved' || record.status === 'denied';
  const options = status !== 'open' ? [APPROVE, DENY] : record.requiresOwnerDecision ? [DENY] : [APPROVE, DENY];
  return {
    id: record.id,
    kind: 'approval',
    status,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    title: clip(`${record.request.tool}: ${record.request.analysis.summary}`, OWNER_ITEM_LIMITS.titleChars),
    detail: approvalDetail(record),
    options,
    createdAt: record.createdAt,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    ...(answered ? {
      answer: {
        option: record.status === 'approved' ? APPROVE : DENY,
        ...(record.decision?.reason !== undefined ? { text: record.decision.reason } : {}),
      },
    } : {}),
    ...(status !== 'open' && record.resolvedBy !== undefined
      ? { answeredBy: { actor: record.resolvedBy, surface: approvalClosingSurface(record) } }
      : {}),
    ...(record.resolvedAt !== undefined ? { closedAt: record.resolvedAt } : {}),
  };
}

/** The refusal for an answer that arrived after the item stopped being open. */
function closedRefusal(item: OwnerItem): Refusal {
  if (item.status === 'answered') {
    const by = item.answeredBy;
    const what = item.answer?.option ?? (item.answer?.text !== undefined ? 'a written answer' : 'an answer');
    return refusal({
      code: 'ALREADY_ANSWERED',
      state: `answered ${what}${by ? ` by ${by.actor} from ${by.surface}` : ''}`,
      reason: `Already answered by ${by ? `${by.actor} from ${by.surface}` : 'someone else'}: ${what}`,
      next: ['Nothing to do; the first answer stands.'],
      status: 409,
    });
  }
  if (item.status === 'expired') {
    return refusal({
      code: 'EXPIRED',
      state: 'expired unanswered',
      reason: 'This item expired before it was answered.',
      next: ['Ask the agent or subsystem that raised it to raise it again if it is still wanted.'],
      status: 409,
    });
  }
  return refusal({
    code: 'WITHDRAWN',
    state: 'withdrawn',
    reason: `This item was withdrawn${item.withdrawnReason ? `: ${item.withdrawnReason}` : ''}.`,
    next: ['Nothing to do; whoever raised it no longer needs an answer.'],
    status: 409,
  });
}

function unknownRefusal(id: string): Refusal {
  return refusal({
    code: 'NOT_FOUND',
    state: 'not in the inbox',
    reason: `No inbox item has the id ${id}.`,
    next: ['List the inbox again and answer an id it shows.'],
    status: 404,
  });
}

function invalidAnswerRefusal(item: OwnerItem, reason: string): Refusal {
  return refusal({
    code: 'INVALID_ARGUMENT',
    state: 'still open',
    reason,
    next: [item.options.length > 0 ? `Answer with one of: ${item.options.join(', ')}.` : 'Answer with text.'],
    status: 400,
  });
}

function matchesFilter(item: OwnerItem, filter: OwnerInboxListFilter, kinds: ReadonlySet<OwnerItemKind> | null): boolean {
  const status = filter.status ?? 'open';
  if (status === 'open' && item.status !== 'open') return false;
  if (status === 'closed' && item.status === 'open') return false;
  if (kinds && !kinds.has(item.kind)) return false;
  if (filter.sessionId !== undefined && item.sessionId !== filter.sessionId) return false;
  return true;
}

function newestFirst(a: OwnerItem, b: OwnerItem): number {
  return (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt) || a.id.localeCompare(b.id);
}

export interface OwnerInboxOptions {
  readonly questions: QuestionStore;
  /** The approval broker of the same composition. Absent: the inbox holds only its own items. */
  readonly approvals?: OwnerInboxApprovalSource | undefined;
  /** Where askers are read from; the first probe that knows an asker answers. See {@link OwnerInbox.usePresence}. */
  readonly presence?: readonly OwnerAskerPresenceProbe[] | undefined;
  readonly now?: (() => number) | undefined;
}

export class OwnerInbox implements RevisionSource, OwnerInboxPort, OwnerAnswerReader {
  readonly id = 'owner inbox';
  readonly #questions: QuestionStore;
  readonly #approvals: OwnerInboxApprovalSource | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<OwnerInboxListener>();
  readonly #unsubscribeApprovals: (() => void) | undefined;
  #probes: OwnerAskerPresenceProbe[];
  #approvalRevision = 0;

  constructor(options: OwnerInboxOptions) {
    this.#questions = options.questions;
    this.#approvals = options.approvals;
    this.#probes = [...(options.presence ?? [])];
    this.#now = options.now ?? Date.now;
    this.#unsubscribeApprovals = this.#approvals?.subscribe((record) => {
      this.#approvalRevision += 1;
      this.#emit(projectApproval(record));
    });
  }

  /** Moves on every post, answer, withdrawal and delivery in any process, and on every approval change. Expiry by time does not move it. */
  revision(): number {
    return this.#questions.revision() + this.#approvalRevision;
  }

  /**
   * Add a place this process reads askers from, ahead of the ones it has: the
   * daemon's hosted sessions, agents and session broker. Read when a question
   * is answered and when a list shows an answer its asker has not taken;
   * nothing is polled. An asker no probe knows reads as closed.
   */
  usePresence(probe: OwnerAskerPresenceProbe): void {
    this.#probes = [probe, ...this.#probes];
  }

  #presenceOf = (asker: OwnerAsker): OwnerAskerPresence => {
    const running = (asker.agent !== undefined && isAskerRunning(this.askerLivenessPath('agent', asker.agent)))
      || (asker.session !== undefined && isAskerRunning(this.askerLivenessPath('session', asker.session)));
    for (const probe of this.#probes) {
      try {
        const found = probe(asker, running);
        if (found) return found;
      } catch (error) {
        logger.debug('[owner-inbox] a presence probe failed; trying the next', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { state: running ? 'attached' : 'closed' };
  };

  /** {@link OwnerAnswerReader}: beside this inbox's store, so every process on the store reads the same lock. */
  askerLivenessPath(kind: OwnerAskerKind, id: string): string {
    return askerLivenessPath(this.#questions.path, kind, id);
  }

  #project(entry: StoredOwnerEntry, now: number): OwnerItem {
    return projectStored(entry, now, this.#presenceOf);
  }

  get(id: string): OwnerItem | undefined {
    const entry = this.#questions.get(id);
    if (entry) return this.#project(entry, this.#now());
    const approval = this.#approvals?.getApproval(id);
    return approval ? projectApproval(approval) : undefined;
  }

  async find(id: string): Promise<OwnerItem | undefined> {
    return this.get(id);
  }

  async list(filter: OwnerInboxListFilter = {}): Promise<readonly OwnerItem[]> {
    return this.listNow(filter);
  }

  /** The same list, for an in-process caller that cannot await. */
  listNow(filter: OwnerInboxListFilter = {}): readonly OwnerItem[] {
    const now = this.#now();
    const kinds = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(filter.limit ?? DEFAULT_LIST_LIMIT)));
    const items: OwnerItem[] = [];
    if (!kinds || kinds.has('approval')) {
      for (const record of this.#approvals?.listApprovals(MAX_LIST_LIMIT) ?? []) {
        const item = projectApproval(record);
        if (matchesFilter(item, filter, kinds)) items.push(item);
      }
    }
    for (const entry of this.#questions.entries()) {
      const item = this.#project(entry, now);
      if (matchesFilter(item, filter, kinds)) items.push(item);
    }
    items.sort(newestFirst);
    return items.length > limit ? items.slice(0, limit) : items;
  }

  /**
   * Post an item for the owner. A post under a key that already has an open item
   * returns that item with `created: false`, so a retried post never asks twice.
   */
  async post(input: NewOwnerItem, postedBy?: string): Promise<OwnerPostOutcome> {
    return this.postNow(input, postedBy);
  }

  postNow(input: NewOwnerItem, postedBy?: string): OwnerPostOutcome {
    const item = validateNewOwnerItem(input);
    const now = this.#now();
    const { created, entry } = this.#questions.post(
      { ...item, ...(postedBy !== undefined ? { postedBy } : {}) },
      now,
      (existing) => storedStatus(existing, now) === 'open',
    );
    const projected = this.#project(entry, now);
    if (created) this.#emit(projected);
    return { created, item: projected };
  }

  /** Who posted an item over the wire, for the route that lets only that principal withdraw it. */
  postedBy(id: string): string | undefined {
    return this.#questions.get(id)?.item.postedBy;
  }

  /**
   * Answer an open item. The first answer wins: a second answer, an answer to a
   * withdrawn or expired item, or an option the item does not offer comes back
   * with `applied: false` and a refusal saying why. Nothing is answered by a
   * timeout or on the owner's behalf.
   */
  async answer(id: string, answer: OwnerAnswer, by: OwnerAnswerSource = { actor: 'owner', surface: 'local' }): Promise<OwnerAnswerOutcome> {
    const now = this.#now();
    const entry = this.#questions.get(id);
    if (entry) {
      const item = this.#project(entry, now);
      if (item.status !== 'open') return { applied: false, item, refusal: closedRefusal(item) };
      const checked = this.#checkAnswer(item, answer);
      if ('refusal' in checked) return { applied: false, item, refusal: checked.refusal };
      const result = this.#questions.answer(id, checked.answer, by, now);
      if (!result) return { applied: false, refusal: unknownRefusal(id) };
      const answered = this.#project(result.entry, now);
      if (!result.applied) return { applied: false, item: answered, refusal: closedRefusal(answered) };
      this.#emit(answered);
      return { applied: true, item: answered, ...(answered.delivery ? { delivery: answered.delivery } : {}) };
    }
    const approval = this.#approvals?.getApproval(id);
    if (!approval || !this.#approvals) return { applied: false, refusal: unknownRefusal(id) };
    return this.#answerApproval(this.#approvals, approval, answer, by);
  }

  /** A producer takes back an open item it posted. Approvals are cancelled through the broker, not here. */
  withdraw(id: string, reason: string): OwnerAnswerOutcome {
    const now = this.#now();
    const result = this.#questions.withdraw(id, clip(reason.trim() || 'no longer needed', 500), now);
    if (!result) return { applied: false, refusal: unknownRefusal(id) };
    const item = this.#project(result.entry, now);
    if (!result.applied) return { applied: false, item, refusal: closedRefusal(item) };
    this.#emit(item);
    return { applied: true, item };
  }

  /**
   * {@link OwnerAnswerReader}: one asker's open questions and the answers it
   * has not taken. A question that expired unanswered is left out: the asker
   * is told of it once while it is open, not again at every reopening.
   */
  pendingFor(scope: QuestionAskerScope): readonly OwnerItem[] {
    const now = this.#now();
    return this.#questions.undelivered(scope).map((entry) => this.#project(entry, now)).filter((item) => item.status !== 'expired');
  }

  /** {@link OwnerAnswerReader}: the caller took the answer into its conversation; true only for the first taker. */
  claim(id: string): boolean {
    const result = this.#questions.recordDelivery(id, 'delivered', undefined, this.#now());
    if (!result?.applied) return false;
    this.#emit(this.#project(result.entry, this.#now()));
    return true;
  }

  /**
   * A session will never be opened again: it was deleted, or it is a hosted
   * session that ended. Its open questions are withdrawn and its waiting
   * answers marked not deliverable, saying why, so every list shows it.
   */
  settleSession(sessionId: string, why: string): void {
    const now = this.#now();
    const changed = this.#questions.settleSession(
      sessionId,
      `${why}, so the question will not be answered there`,
      `${why} before the answer reached it. The answer is kept on the question.`,
      now,
    );
    for (const id of changed) {
      const entry = this.#questions.get(id);
      if (entry) this.#emit(this.#project(entry, now));
    }
  }

  /**
   * The asking side's report on an answer: it took the answer into its
   * conversation (`delivered`), or never can (`undeliverable`, its session was
   * deleted). Reported over the wire by a terminal whose daemon keeps a
   * different store (a connected host on another machine); a process on the
   * store itself uses {@link claim} and {@link settleSession}. Only an answered
   * question a session asked takes a report, once; a second one is refused and
   * changes nothing, so the session that reports `delivered` first is the one
   * that puts the answer in its conversation.
   */
  reportDelivery(id: string, report: OwnerAnswerDeliveryReport): OwnerAnswerOutcome {
    const now = this.#now();
    const entry = this.#questions.get(id);
    if (!entry) return { applied: false, refusal: unknownRefusal(id) };
    const item = this.#project(entry, now);
    if (item.status !== 'answered' || answerSessionOf(item) === undefined) {
      return {
        applied: false,
        item,
        refusal: refusal({
          code: 'NOT_A_SESSION_ANSWER',
          state: item.status,
          reason: item.status !== 'answered' ? 'This item has no answer to deliver.' : 'This answer goes to an agent; the agent records taking it.',
          next: ['Nothing to do.'],
          status: 409,
        }),
      };
    }
    const reason = report.reason !== undefined ? clip(report.reason.trim(), 500) : undefined;
    const result = this.#questions.recordDelivery(id, report.state, reason || undefined, now);
    if (!result) return { applied: false, refusal: unknownRefusal(id) };
    const updated = this.#project(result.entry, now);
    if (!result.applied) {
      return {
        applied: false,
        item: updated,
        refusal: refusal({
          code: 'ALREADY_REPORTED',
          state: updated.delivery?.state ?? 'answered',
          reason: `This answer was already reported ${updated.delivery?.state ?? 'handled'}.`,
          next: ['Nothing to do; the first report stands.'],
          status: 409,
        }),
      };
    }
    this.#emit(updated);
    return { applied: true, item: updated, ...(updated.delivery ? { delivery: updated.delivery } : {}) };
  }

  /**
   * Resolves when the item stops being open (answered, withdrawn, or found
   * expired when checked). Rejects when the signal aborts. One listener while
   * waiting; nothing polls.
   */
  waitForAnswer(id: string, signal?: AbortSignal): Promise<OwnerItem> {
    const current = this.get(id);
    if (!current) return Promise.reject(new Error(`No inbox item has the id ${id}.`));
    if (current.status !== 'open') return Promise.resolve(current);
    return new Promise<OwnerItem>((resolve, reject) => {
      let unsubscribe: () => void = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (settle: () => void) => {
        unsubscribe();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error('Stopped waiting for the owner.')));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      unsubscribe = this.subscribe((item) => {
        if (item.id === id && item.status !== 'open') finish(() => resolve(item));
      });
      if (current.expiresAt !== undefined) {
        // Expiry is read, not written; wake once at the deadline so the waiter sees it.
        timer = setTimeout(() => {
          const latest = this.get(id);
          if (latest && latest.status !== 'open') finish(() => resolve(latest));
        }, Math.max(0, current.expiresAt - this.#now()) + 1);
        timer.unref?.();
      }
    });
  }

  subscribe(listener: OwnerInboxListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  dispose(): void {
    this.#unsubscribeApprovals?.();
    this.#listeners.clear();
    this.#questions.close();
  }

  #checkAnswer(item: OwnerItem, answer: OwnerAnswer): { answer: OwnerAnswer } | { refusal: Refusal } {
    const text = typeof answer.text === 'string' && answer.text.trim().length > 0 ? answer.text.trim() : undefined;
    if (text !== undefined && text.length > OWNER_ITEM_LIMITS.answerTextChars) {
      return { refusal: invalidAnswerRefusal(item, `The answer is longer than ${OWNER_ITEM_LIMITS.answerTextChars} characters.`) };
    }
    if (item.options.length === 0) {
      if (text === undefined) return { refusal: invalidAnswerRefusal(item, 'This item takes a written answer.') };
      return { answer: { text } };
    }
    const wanted = typeof answer.option === 'string' ? answer.option.trim().toLowerCase() : '';
    const option = item.options.find((candidate) => candidate.toLowerCase() === wanted);
    if (option === undefined) {
      return { refusal: invalidAnswerRefusal(item, wanted ? `"${answer.option}" is not one of this item's choices.` : 'Choose one of this item\'s choices.') };
    }
    return { answer: { option, ...(text !== undefined ? { text } : {}) } };
  }

  async #answerApproval(
    broker: OwnerInboxApprovalSource,
    record: SharedApprovalRecord,
    answer: OwnerAnswer,
    by: OwnerAnswerSource,
  ): Promise<OwnerAnswerOutcome> {
    const item = projectApproval(record);
    if (item.status !== 'open') return { applied: false, item, refusal: closedRefusal(item) };
    const checked = this.#checkAnswer(item, answer);
    if ('refusal' in checked) return { applied: false, item, refusal: checked.refusal };
    const approved = checked.answer.option === APPROVE;
    const outcome: ApprovalActionOutcome = {};
    let updated: SharedApprovalRecord | null;
    try {
      updated = await broker.resolveApproval(record.id, {
        approved,
        disposition: approved ? 'approved' : 'denied',
        actor: by.actor,
        actorSurface: by.surface,
        ...(checked.answer.text !== undefined ? (approved ? { note: checked.answer.text } : { reason: checked.answer.text }) : {}),
        outcome,
      });
    } catch (error) {
      const latest = broker.getApproval(record.id);
      return {
        applied: false,
        ...(latest ? { item: projectApproval(latest) } : {}),
        refusal: refusal({
          code: 'ANSWER_NOT_RECORDED',
          state: latest && approvalStatus(latest) === 'open' ? 'still open' : 'changed while answering',
          reason: `The answer was not recorded: ${error instanceof Error ? error.message : String(error)}`,
          next: ['List the inbox again; answer again if it is still open.'],
          retryable: true,
        }),
      };
    }
    if (!updated) return { applied: false, refusal: unknownRefusal(record.id) };
    const projected = projectApproval(updated);
    if (!outcome.applied) return { applied: false, item: projected, refusal: closedRefusal(projected) };
    return { applied: true, item: projected };
  }

  #emit(item: OwnerItem): void {
    // Surfaces outside the daemon (a terminal waiting on its question, the web UI)
    // learn of the change from the stream; an approval is already on approval-update.
    if (item.kind !== 'approval') {
      try {
        this.#approvals?.eventPublisher?.publishEvent(OWNER_INBOX_UPDATE_WIRE_EVENT, { item, createdAt: this.#now() });
      } catch (error) {
        logger.warn('[owner-inbox] the update could not be published', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(item);
      } catch (error) {
        logger.warn('[owner-inbox] a listener failed', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

/**
 * Build an inbox over the home's one store at `questionsPath`
 * (question-store.ts `ownerInboxStorePath`) and, in the daemon, its approval
 * broker. Every instance in one process shares one connection to the store.
 */
export function createOwnerInbox(options: {
  readonly questionsPath: string;
  readonly approvals?: OwnerInboxApprovalSource | undefined;
  readonly presence?: readonly OwnerAskerPresenceProbe[] | undefined;
  readonly now?: (() => number) | undefined;
}): OwnerInbox {
  return new OwnerInbox({
    questions: sharedQuestionStore(options.questionsPath),
    ...(options.approvals !== undefined ? { approvals: options.approvals } : {}),
    ...(options.presence !== undefined ? { presence: options.presence } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

const ITEM_STATUSES: ReadonlySet<string> = new Set<OwnerItemStatus>(['open', 'answered', 'withdrawn', 'expired']);
const ITEM_KINDS: ReadonlySet<string> = new Set<string>(OWNER_ITEM_KINDS);
const DELIVERY_STATES: ReadonlySet<string> = new Set<OwnerAnswerDeliveryState>(['delivered', 'waiting', 'undeliverable']);

/** Read an answer's delivery from the wire; undefined when it is not one. */
export function readOwnerAnswerDelivery(value: unknown): OwnerAnswerDelivery | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['state'] !== 'string' || !DELIVERY_STATES.has(record['state']) || typeof record['to'] !== 'string') return undefined;
  return {
    state: record['state'] as OwnerAnswerDeliveryState,
    to: record['to'],
    ...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
  };
}

/** Read an inbox item from the wire; undefined when it is not one. */
export function readOwnerItem(value: unknown): OwnerItem | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['kind'] !== 'string' || !ITEM_KINDS.has(record['kind'])
    || typeof record['status'] !== 'string' || !ITEM_STATUSES.has(record['status'])
    || typeof record['title'] !== 'string' || typeof record['detail'] !== 'string'
    || !Array.isArray(record['options']) || !record['options'].every((option) => typeof option === 'string')
    || typeof record['createdAt'] !== 'number') {
    return undefined;
  }
  if (record['delivery'] === undefined) return record as unknown as OwnerItem;
  const { delivery: rawDelivery, ...rest } = record;
  const delivery = readOwnerAnswerDelivery(rawDelivery);
  return { ...(rest as unknown as OwnerItem), ...(delivery ? { delivery } : {}) };
}
