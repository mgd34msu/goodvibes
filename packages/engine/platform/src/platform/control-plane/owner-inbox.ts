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
import { randomUUID } from 'node:crypto';
import { refusal, type Refusal } from '@goodvibes-jev/engine/errors';
import type { ApprovalBroker, SharedApprovalRecord } from './approval-broker.js';
import { approvalViewerOfActor, localApprovalActions, type ApprovalActions } from './approval-actions.js';
import type { Actor } from '@goodvibes-jev/engine/daemon-api/http-policy';
import { formatApprovalRef, readApproval, type ApprovalReading, type ApprovalViewer } from './approval-lifecycle.js';
import { FenceIssuer } from '../utils/owner-fence.js';
import {
  OWNER_ANSWER_AGENT_METADATA,
  OWNER_ANSWER_SESSION_METADATA,
  OWNER_ASKER_SESSION_FILE_METADATA,
  sessionFileMatches,
  sharedQuestionStore,
  storedEntryVersion,
  type QuestionAskerScope,
  type QuestionStore,
  type StoredOwnerEntry,
  type StoredOwnerItem,
  type StoredOwnerItemKind,
} from './question-store.js';
import type { RevisionSource } from '../utils/revision.js';
import type { AskPresentation } from '../permissions/ask-presentation.js';
import type { PermissionPromptRequest } from '../permissions/prompt.js';
import { logger } from '../utils/logger.js';
import { askerLivenessPath, isTakerGone, processTaker, sessionAskerKey, settleAskerLock, type OwnerAskerKind } from './owner-asker-liveness.js';

export { OWNER_ANSWER_AGENT_METADATA, OWNER_ANSWER_SESSION_METADATA, OWNER_ASKER_SESSION_FILE_METADATA };

/**
 * `decision` is a call Jev decided for the owner at the permission gate: it is
 * open while the owner can still act on it (undo, never, always, ask, keep),
 * and only a list that names the kind shows it, so it never reads as something
 * waiting on him.
 *
 * `report` is the answer of a run nobody was watching (a scheduled run or a
 * trigger's turn) that named no surface to deliver to, or whose delivery
 * failed: it is open until the owner answers `read`.
 */
export type OwnerItemKind = 'approval' | 'question' | 'claim' | 'purchase' | 'queued-action' | 'decision' | 'report';
export type OwnerItemStatus = 'open' | 'answered' | 'withdrawn' | 'expired';

/** An answer: one of the item's options, or free text when it has none. Text may accompany an option. */
export interface OwnerAnswer {
  readonly option?: string | undefined;
  readonly text?: string | undefined;
  /**
   * For an approval: the `revision` of the approval the answer was given to
   * (the item's `revision`). Required for approvals; a stale one is refused
   * with the current reading. Never stored on a question's answer.
   */
  readonly expectedRevision?: number | undefined;
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
  /** For an approval: the record's revision (send it as `expectedRevision` when answering). */
  readonly revision?: number | undefined;
  /** For an approval: its reading for the viewer that listed it (approval-lifecycle.ts). */
  readonly reading?: ApprovalReading | undefined;
  /**
   * What the ask says (permissions/ask-presentation.ts): its question,
   * consequence, choices and why, the same words on every surface. Present
   * where the inbox was given the facts to word it (the daemon's).
   */
  readonly presentation?: AskPresentation | undefined;
}

/** Words an item: the ask's request for an approval item, the item alone otherwise. */
export type OwnerItemPresenter = (item: OwnerItem, request?: PermissionPromptRequest) => AskPresentation;

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
  /** Who is reading, for an approval's reading; the owner when absent. */
  readonly viewer?: ApprovalViewer | undefined;
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

/**
 * Whether session `sessionId`, whose saved file is `sessionFile` (its identity;
 * undefined for a session that has none), asked `item`. A namesake in another
 * app or project is another session.
 */
export function isAskedBySession(item: Pick<OwnerItem, 'metadata'>, sessionId: string | undefined, sessionFile: string | undefined): boolean {
  if (sessionId === undefined || answerSessionOf(item) !== sessionId) return false;
  return sessionFileMatches(metadataText(item, OWNER_ASKER_SESSION_FILE_METADATA), sessionFile);
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
  /** One asker's open questions and the answers it has not had delivered (one indexed read). */
  pendingFor(scope: QuestionAskerScope): readonly OwnerItem[];
  /**
   * The caller is putting the answer on a model request: it is marked taken by
   * this process. True for the first taker, for this process taking it again,
   * and for a take after the taker that held it died; false otherwise.
   */
  take(id: string): boolean;
  /** The request carrying these answers was accepted: they are delivered. One statement. */
  confirmDelivered(ids: readonly string[]): void;
  /** The lock file a running asker holds while it waits on a question (owner-asker-liveness.ts). */
  askerLivenessPath(kind: OwnerAskerKind, id: string): string;
}

export type OwnerAnswerOutcome =
  | { readonly applied: true; readonly item: OwnerItem; readonly delivery?: OwnerAnswerDelivery | undefined }
  | { readonly applied: false; readonly item?: OwnerItem | undefined; readonly refusal: Refusal };

export type OwnerPostOutcome =
  | { readonly created: boolean; readonly item: OwnerItem };

export type OwnerInboxListener = (item: OwnerItem) => void;

/** The part of the approval broker the inbox reads and answers through (through the approvals port, approval-actions.ts). */
export type OwnerInboxApprovalSource = Pick<ApprovalBroker, 'homeNode' | 'listApprovals' | 'getApproval' | 'claimApproval' | 'resolveApproval' | 'cancelApproval' | 'releaseApproval' | 'subscribe'>
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
  find(id: string, viewer?: ApprovalViewer): Promise<OwnerItem | undefined>;
  answer(id: string, answer: OwnerAnswer): Promise<OwnerAnswerOutcome>;
}

export const OWNER_ITEM_KINDS: readonly OwnerItemKind[] = ['approval', 'question', 'claim', 'purchase', 'queued-action', 'decision', 'report'];
export const OWNER_ITEM_LIMITS = Object.freeze({
  titleChars: 200,
  detailChars: 4000,
  options: 8,
  optionChars: 40,
  answerTextChars: 4000,
  keyChars: 200,
  metadataEntries: 16,
});

const POSTABLE_KINDS: ReadonlySet<string> = new Set<StoredOwnerItemKind>(['question', 'claim', 'purchase', 'queued-action', 'decision', 'report']);

/**
 * Applies the owner's choice on a `decision` item in the process whose gate
 * made the decision; resolves with what was done, in words, or throws to say
 * why it could not be done (the item then stays open).
 */
export type OwnerDecisionHandler = (item: OwnerItem, option: string, signal?: AbortSignal) => Promise<string>;

/** Decision handlers of this process, by the key prefix their items are posted under. */
const decisionHandlers = new Map<string, OwnerDecisionHandler>();

/** Handle the owner's choices on decision items posted under `keyPrefix`; returns the unregister. */
export function handleOwnerDecisions(keyPrefix: string, handler: OwnerDecisionHandler): () => void {
  decisionHandlers.set(keyPrefix, handler);
  return () => { if (decisionHandlers.get(keyPrefix) === handler) decisionHandlers.delete(keyPrefix); };
}

function decisionHandlerFor(key: string | undefined): OwnerDecisionHandler | undefined {
  if (key === undefined) return undefined;
  for (const [prefix, handler] of decisionHandlers) if (key.startsWith(prefix)) return handler;
  return undefined;
}

/** True when this process made the decision posted under `key`, so the owner's choice on it is applied here. */
export function isOwnerDecisionHandledHere(key: string | undefined): boolean {
  return decisionHandlerFor(key) !== undefined;
}
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
    throw new OwnerInboxInputError('kind must be question, claim, purchase, queued-action, decision or report; permission asks are raised through approvals.', 'kind');
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
  // A decision whose choice is being applied was claimed inside its deadline: it stays open until that commits.
  if (entry.applyingToken === undefined && entry.item.expiresAt !== undefined && entry.item.expiresAt <= now) return 'expired';
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

/** `localNode`: this inbox's node; another node's approval (listed through the group) is named `<id>@<node>`. */
function projectApproval(record: SharedApprovalRecord, reading?: ApprovalReading, localNode?: string): OwnerItem {
  const status = approvalStatus(record);
  const answered = record.status === 'approved' || record.status === 'denied';
  // The choices are the viewer's allowed actions when there is a reading: an agent reading the inbox is offered none.
  const options = status !== 'open' ? [APPROVE, DENY]
    : reading ? [...(reading.allowedActions.includes('approve') ? [APPROVE] : []), ...(reading.allowedActions.includes('deny') ? [DENY] : [])]
      : record.requiresOwnerDecision ? [DENY] : [APPROVE, DENY];
  return {
    revision: record.revision,
    ...(reading !== undefined ? { reading } : {}),
    id: localNode === undefined || record.homeNode === localNode ? record.id : formatApprovalRef({ node: record.homeNode, id: record.id }),
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

function decisionInProgressRefusal(): Refusal {
  return refusal({
    code: 'DECISION_IN_PROGRESS', state: 'still open', status: 409,
    reason: 'A choice on this decision is being applied right now.',
    next: ['Show it again in a moment; the choice being applied decides it.'],
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
  // An open decision waits on no one: it is listed only where it is asked for by kind (/decisions).
  if (!kinds && status === 'open' && item.kind === 'decision') return false;
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
  /** The approvals port to read and answer through; the local one over `approvals` when absent. */
  readonly approvalActions?: ApprovalActions | undefined;
  /** Where askers are read from; the first probe that knows an asker answers. See {@link OwnerInbox.usePresence}. */
  readonly presence?: readonly OwnerAskerPresenceProbe[] | undefined;
  readonly now?: (() => number) | undefined;
}

export class OwnerInbox implements RevisionSource, OwnerInboxPort, OwnerAnswerReader {
  readonly id = 'owner inbox';
  readonly #questions: QuestionStore;
  readonly #approvals: OwnerInboxApprovalSource | undefined;
  /** The approvals port over the broker: every approval item is read and answered through it. */
  readonly #approvalActions: ApprovalActions | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<OwnerInboxListener>();
  /** Decision handlers run under a fence of this inbox, narrowed to the item's deadline; dispose stops them. */
  readonly #decisionFences = new FenceIssuer('owner decisions');
  readonly #unsubscribeApprovals: (() => void) | undefined;
  #probes: OwnerAskerPresenceProbe[];
  #approvalRevision = 0;
  /** While anyone listens: the store's change feed, so a change made by another process is heard too. */
  #stopStoreChanges: (() => void) | null = null;
  /** Words for each item; set by the composition with the facts (usePresentation). */
  #presenter: OwnerItemPresenter | null = null;
  /** Rows this inbox already announced itself, by id: the store's feed repeats them and is skipped once. */
  readonly #announced = new Map<string, string>();

  constructor(options: OwnerInboxOptions) {
    this.#questions = options.questions;
    this.#approvals = options.approvals;
    this.#approvalActions = options.approvalActions ?? (options.approvals ? localApprovalActions(options.approvals) : undefined);
    this.#probes = [...(options.presence ?? [])];
    this.#now = options.now ?? Date.now;
    this.#unsubscribeApprovals = this.#approvals?.subscribe((record) => {
      this.#approvalRevision += 1;
      this.#emit(projectApproval(record, readApproval(record, this.#viewer(undefined), this.#now())));
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

  /** Whether the asker has a question still open (not answered, withdrawn or expired). One indexed read. */
  #hasOpenQuestion(scope: QuestionAskerScope): boolean {
    const now = this.#now();
    return this.#questions.undelivered(scope).some((entry) => storedStatus(entry, now) === 'open');
  }

  /**
   * Whether the asker is running (some process holds its lock). When it is not
   * and it has no open question left, its lock file is removed under the lock:
   * a file exists only while a question from that asker is open or the asker
   * runs. Called by every close of a question and by every read of an asker.
   */
  #settleAsker(asker: OwnerAsker): boolean {
    let running = false;
    if (asker.agent !== undefined) {
      const agent = asker.agent;
      running = settleAskerLock(this.askerLivenessPath('agent', agent), () => !this.#hasOpenQuestion({ agent })) || running;
    }
    if (asker.session !== undefined) {
      const scope = { session: asker.session, sessionFile: asker.sessionFile };
      const key = sessionAskerKey({ session: asker.session, sessionFile: asker.sessionFile });
      running = settleAskerLock(this.askerLivenessPath('session', key), () => !this.#hasOpenQuestion(scope)) || running;
    }
    return running;
  }

  /** A question of this asker closed: its lock file goes if nothing of it is open or running any more. */
  #closed(item: Pick<OwnerItem, 'metadata'>): void {
    const asker = askerOf(item);
    if (asker === undefined) return;
    try {
      this.#settleAsker(asker);
    } catch (error) {
      logger.debug('[owner-inbox] could not settle an asker\'s lock after a question closed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  #presenceOf = (asker: OwnerAsker): OwnerAskerPresence => {
    const running = this.#settleAsker(asker);
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
    const item = projectStored(entry, now, this.#presenceOf);
    // Expiry closes a question without any write; the first read after it settles the asker's lock file.
    if (item.status === 'expired' && entry.closedAt === undefined) this.#closed(item);
    return item;
  }

  /** The viewer an authenticated actor is, for approval items (no actor: the owner, in this process). */
  viewerOf(actor: Actor | undefined): ApprovalViewer {
    return this.#approvalActions?.viewerOf(actor) ?? approvalViewerOfActor(actor, 'local');
  }

  /** The viewer an item is read for when none is named: the owner, in this process. */
  #viewer(viewer: ApprovalViewer | undefined): ApprovalViewer {
    return viewer ?? this.#approvalActions?.viewerOf(undefined)
      ?? { kind: 'owner-route', scopes: ['*'], node: 'local', mayAnswer: true, mayAdminister: true };
  }

  /**
   * Word every item this inbox lists, answers or announces with `presenter`:
   * the composition that holds the facts (the mode in force, the session
   * titles, the purchase windows) sets it. One pure call per item listed.
   */
  usePresentation(presenter: OwnerItemPresenter | null): void {
    this.#presenter = presenter;
  }

  /**
   * The item with its words, and an approval's title from them; unchanged
   * without a presenter. Compact in a list or an event; in full (with the
   * details) for the read of one item.
   */
  #present(item: OwnerItem, full = false): OwnerItem {
    const presenter = this.#presenter;
    if (presenter === null) return item;
    try {
      const request = item.kind === 'approval' ? this.#approvals?.getApproval(item.id)?.request : undefined;
      const worded = presenter(item, request);
      // Compact: the details (arguments, checklist) stay for the read of one item (ask-presentation.ts compactAskPresentation).
      const presentation: AskPresentation = full ? worded : { ...worded, details: [] };
      return { ...item, presentation, ...(item.kind === 'approval' ? { title: presentation.title } : {}) };
    } catch (error) {
      logger.debug('[owner-inbox] an item could not be worded; it is listed without its words', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      return item;
    }
  }

  get(id: string, viewer?: ApprovalViewer): OwnerItem | undefined {
    const entry = this.#questions.get(id);
    if (entry) return this.#present(this.#project(entry, this.#now()), true);
    const row = this.#approvalActions?.get(id, this.#viewer(viewer));
    return row ? this.#present(projectApproval(row.record, row.reading, this.#approvalActions?.homeNode), true) : undefined;
  }

  async find(id: string, viewer?: ApprovalViewer): Promise<OwnerItem | undefined> {
    return this.get(id, viewer);
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
      for (const row of this.#approvalActions?.list(this.#viewer(filter.viewer), MAX_LIST_LIMIT) ?? []) {
        const item = projectApproval(row.record, row.reading, this.#approvalActions?.homeNode);
        if (matchesFilter(item, filter, kinds)) items.push(item);
      }
    }
    for (const entry of this.#questions.entries()) {
      const item = this.#project(entry, now);
      if (matchesFilter(item, filter, kinds)) items.push(item);
    }
    items.sort(newestFirst);
    return (items.length > limit ? items.slice(0, limit) : items).map((item) => this.#present(item));
  }

  /**
   * Post an item for the owner. A post under a key that already has an open item
   * the same poster posted returns that item with `created: false`, so a retried
   * post never asks twice; another poster's item is never returned.
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
    if (created) this.#emitStored(entry, projected);
    return { created, item: projected };
  }

  /**
   * The newest item ever posted under `key`, open or closed: for a producer
   * that asks once per key, not once per open item. Reads the cached rows (a
   * store read only when the store moved).
   */
  latestByKey(kind: StoredOwnerItemKind, key: string): OwnerItem | undefined {
    let latest: StoredOwnerEntry | undefined;
    for (const entry of this.#questions.entries()) {
      if (entry.item.kind !== kind || entry.item.key !== key) continue;
      if (latest === undefined || entry.item.createdAt >= latest.item.createdAt) latest = entry;
    }
    return latest === undefined ? undefined : this.#project(latest, this.#now());
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
  async answer(id: string, answer: OwnerAnswer, by: OwnerAnswerSource = { actor: 'owner', surface: 'local' }, viewer?: ApprovalViewer): Promise<OwnerAnswerOutcome> {
    const now = this.#now();
    const entry = this.#questions.get(id);
    if (entry) {
      const item = this.#project(entry, now);
      if (item.status !== 'open') return { applied: false, item, refusal: closedRefusal(item) };
      if (entry.applyingToken !== undefined && !isTakerGone(this.#questions.path, entry.applyingToken)) {
        return { applied: false, item, refusal: decisionInProgressRefusal() };
      }
      const checked = this.#checkAnswer(item, answer);
      if ('refusal' in checked) return { applied: false, item, refusal: checked.refusal };
      if (item.kind === 'decision') return this.#answerDecision(item, checked.answer, by);
      // The deadline and "still open" are checked in the UPDATE that writes the answer.
      const result = this.#questions.answer(id, checked.answer, by, this.#now());
      if (!result) return { applied: false, refusal: unknownRefusal(id) };
      const answered = this.#project(result.entry, now);
      if (!result.applied) return { applied: false, item: answered, refusal: closedRefusal(answered) };
      this.#emitStored(result.entry, answered);
      this.#closed(answered);
      return { applied: true, item: answered, ...(answered.delivery ? { delivery: answered.delivery } : {}) };
    }
    const actions = this.#approvalActions;
    const row = actions?.get(id, this.#viewer(viewer));
    if (!row || !actions) return { applied: false, refusal: unknownRefusal(id) };
    // Who may answer is decided before this runs: `inbox.answer` declares `approval.answer`
    // (the owner's own act) and a channel reply is admitted for its sender (approval-reply.ts).
    return this.#answerApproval(actions, row.record, answer, by, this.#viewer(viewer));
  }

  /** A producer takes back an open item it posted. Approvals are cancelled through the broker, not here. Refused while a decision on it is being applied. */
  withdraw(id: string, reason: string): OwnerAnswerOutcome {
    const now = this.#now();
    const result = this.#questions.withdraw(id, clip(reason.trim() || 'no longer needed', 500), now);
    if (!result) return { applied: false, refusal: unknownRefusal(id) };
    const item = this.#project(result.entry, now);
    if (!result.applied && item.status === 'open' && result.entry.applyingToken !== undefined) {
      return { applied: false, item, refusal: decisionInProgressRefusal() };
    }
    if (!result.applied) return { applied: false, item, refusal: closedRefusal(item) };
    this.#emitStored(result.entry, item);
    this.#closed(item);
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

  /**
   * {@link OwnerAnswerReader}: the caller is putting the answer on a model
   * request. Marked taken by this process (one row write); delivered only by
   * {@link confirmDelivered} once that request was accepted. A row taken by a
   * process that died is taken again.
   */
  take(id: string): boolean {
    const path = this.#questions.path;
    return this.#questions.take(id, processTaker(path), this.#now(), (taker) => isTakerGone(path, taker));
  }

  /** {@link OwnerAnswerReader}: the requests carrying these answers were accepted; they are delivered (one statement). */
  confirmDelivered(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const now = this.#now();
    for (const id of this.#questions.confirmDelivered(ids, processTaker(this.#questions.path), now)) {
      const entry = this.#questions.get(id);
      if (!entry) continue;
      this.#emitStored(entry, this.#project(entry, now));
      this.#closed(entry.item);
    }
  }

  /**
   * A session will never be opened again: it was deleted, or it is a hosted
   * session that ended. Its open questions are withdrawn and its waiting
   * answers marked not deliverable, saying why, so every list shows it.
   * `sessionFile` is a terminal session's identity (its saved file); a
   * namesake's questions in another app or project are left alone.
   */
  settleSession(sessionId: string, why: string, sessionFile?: string): void {
    const now = this.#now();
    const changed = this.#questions.settleSession(
      sessionId,
      `${why}, so the question will not be answered there`,
      `${why} before the answer reached it. The answer is kept on the question.`,
      now,
      sessionFile,
    );
    for (const id of changed) {
      const entry = this.#questions.get(id);
      if (entry) {
        this.#emitStored(entry, this.#project(entry, now));
        this.#closed(entry.item);
      }
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
    this.#emitStored(result.entry, updated);
    this.#closed(updated);
    return { applied: true, item: updated, ...(updated.delivery ? { delivery: updated.delivery } : {}) };
  }

  /**
   * Resolves when the item stops being open (answered, withdrawn, or found
   * expired when checked), whichever process closed it: an answer another
   * process wrote to the store is heard through the store's change feed.
   * Rejects when the signal aborts. One listener while waiting; nothing polls.
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
      // The feed starts from the rows as they are now; an answer another process wrote since the read above is in them.
      const since = this.get(id);
      if (since && since.status !== 'open') { finish(() => resolve(since)); return; }
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

  /**
   * Hear every change of an item: this inbox's own writes at once, and a
   * write by another inbox or another process on the same store (a terminal
   * app answering the store directly) at the end of the turn it lands in.
   */
  subscribe(listener: OwnerInboxListener): () => void {
    this.#listeners.add(listener);
    this.#stopStoreChanges ??= this.#questions.onChange((changed) => this.#heard(changed));
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stopListening();
    };
  }

  dispose(): void {
    this.#decisionFences.retire('the owner inbox closed');
    this.#unsubscribeApprovals?.();
    this.#listeners.clear();
    this.#stopListening();
    this.#questions.close();
  }

  #stopListening(): void {
    this.#stopStoreChanges?.();
    this.#stopStoreChanges = null;
    this.#announced.clear();
  }

  /** Rows the store reports changed: each one this inbox did not announce itself is announced now. */
  #heard(changed: readonly StoredOwnerEntry[]): void {
    const now = this.#now();
    for (const entry of changed) {
      const id = entry.item.id;
      const own = this.#announced.get(id);
      this.#announced.delete(id);
      if (own === storedEntryVersion(entry)) continue;
      this.#emit(this.#project(entry, now));
    }
  }

  /** Announce a change this inbox wrote, and note it so the store's feed does not announce it twice. */
  #emitStored(entry: StoredOwnerEntry, item: OwnerItem): void {
    if (this.#stopStoreChanges !== null) this.#announced.set(entry.item.id, storedEntryVersion(entry));
    this.#emit(item);
  }

  /**
   * A decision item's choice is carried out before it is recorded, by the
   * process whose gate decided, so the answer on the item says what was done.
   * Claim, apply, commit: the item is claimed in the store before the handler
   * runs (a second choice, a withdrawal and the deadline are refused while the
   * claim is held), the handler runs under a fence whose deadline is the
   * item's, and the claim's own token commits the answer.
   */
  async #answerDecision(item: OwnerItem, answer: OwnerAnswer, by: OwnerAnswerSource): Promise<OwnerAnswerOutcome> {
    const handler = decisionHandlerFor(item.key);
    if (!handler) {
      return {
        applied: false, item,
        refusal: refusal({
          code: 'DECIDED_ELSEWHERE',
          state: 'still open',
          reason: `Jev made this decision in ${typeof item.metadata?.['surface'] === 'string' ? item.metadata['surface'] : 'another app'}, and only that app can apply a choice on it.`,
          next: ['Choose it with /decisions in the app that made it while that session is running.', 'Or set a standing rule with /permissions.'],
          status: 409,
        }),
      };
    }
    const path = this.#questions.path;
    const token = `${processTaker(path)}:${randomUUID()}`;
    const claimed = this.#questions.claimDecision(item.id, token, this.#now(), (held) => isTakerGone(path, held.split(':')[0] ?? held));
    if (!claimed) return { applied: false, refusal: unknownRefusal(item.id) };
    if (!claimed.claimed) {
      const current = this.#project(claimed.entry, this.#now());
      return { applied: false, item: current, refusal: current.status === 'open' ? decisionInProgressRefusal() : closedRefusal(current) };
    }
    this.#emitStored(claimed.entry, this.#project(claimed.entry, this.#now()));
    const fence = this.#decisionFences.peek().narrow({ deadline: item.expiresAt });
    let done: string;
    try {
      fence.check();
      done = await handler(item, answer.option ?? '', fence.signal);
    } catch (error) {
      this.#questions.releaseDecision(item.id, token, this.#now());
      const released = this.#questions.get(item.id);
      return {
        applied: false,
        ...(released ? { item: this.#project(released, this.#now()) } : {}),
        refusal: refusal({
          code: 'DECISION_NOT_APPLIED',
          state: 'still open',
          reason: error instanceof Error ? error.message : String(error),
          next: ['Choose another action, or keep the decision as it is.'],
          status: 409,
        }),
      };
    }
    const recorded: OwnerAnswer = { option: answer.option, text: clip(done, OWNER_ITEM_LIMITS.answerTextChars) };
    const now = this.#now();
    const result = this.#questions.commitDecision(item.id, token, recorded, by, now);
    if (!result) return { applied: false, refusal: unknownRefusal(item.id) };
    const answered = this.#project(result.entry, now);
    if (!result.applied) return { applied: false, item: answered, refusal: closedRefusal(answered) };
    this.#emitStored(result.entry, answered);
    this.#closed(answered);
    return { applied: true, item: answered };
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
    actions: ApprovalActions,
    record: SharedApprovalRecord,
    answer: OwnerAnswer,
    by: OwnerAnswerSource,
    viewer: ApprovalViewer,
  ): Promise<OwnerAnswerOutcome> {
    const ref = record.homeNode === actions.homeNode ? record.id : formatApprovalRef({ node: record.homeNode, id: record.id });
    const item = projectApproval(record, actions.get(ref, viewer)?.reading, actions.homeNode);
    if (item.status !== 'open') return { applied: false, item, refusal: closedRefusal(item) };
    // The answer names the revision of the approval it was given to; without it nothing is answered.
    if (typeof answer.expectedRevision !== 'number' || !Number.isInteger(answer.expectedRevision)) {
      return { applied: false, item, refusal: invalidAnswerRefusal(item, 'Send expectedRevision, the revision of the approval you were shown (the item\'s revision).') };
    }
    const checked = this.#checkAnswer(item, answer);
    if ('refusal' in checked) return { applied: false, item, refusal: checked.refusal };
    const approved = checked.answer.option === APPROVE;
    let outcome: Awaited<ReturnType<ApprovalActions['resolve']>>;
    try {
      outcome = await actions.resolve(ref, {
        approved,
        disposition: approved ? 'approved' : 'denied',
        actor: by.actor,
        actorSurface: by.surface,
        expectedRevision: answer.expectedRevision,
        ...(checked.answer.text !== undefined ? (approved ? { note: checked.answer.text } : { reason: checked.answer.text }) : {}),
      }, viewer);
    } catch (error) {
      const latest = actions.get(ref, viewer);
      return {
        applied: false,
        ...(latest ? { item: projectApproval(latest.record, latest.reading, actions.homeNode) } : {}),
        refusal: refusal({
          code: 'ANSWER_NOT_RECORDED',
          state: latest && approvalStatus(latest.record) === 'open' ? 'still open' : 'changed while answering',
          reason: `The answer was not recorded: ${error instanceof Error ? error.message : String(error)}`,
          next: ['List the inbox again; answer again if it is still open.'],
          retryable: true,
        }),
      };
    }
    if (!outcome.record) return { applied: false, refusal: outcome.applied ? unknownRefusal(ref) : outcome.refusal };
    const projected = projectApproval(outcome.record, outcome.reading ?? undefined, actions.homeNode);
    // A stale or settled answer comes back with the approval's current reading and the broker's own refusal.
    if (!outcome.applied) return { applied: false, item: projected, refusal: outcome.refusal };
    return { applied: true, item: projected };
  }

  #emit(projected: OwnerItem): void {
    const item = this.#present(projected);
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
