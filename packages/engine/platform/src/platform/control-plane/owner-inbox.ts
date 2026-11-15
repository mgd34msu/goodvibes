/**
 * The owner inbox: one list of everything waiting on the owner, answered once,
 * from any surface.
 *
 * It holds two sources behind one shape. Permission asks stay in the approval
 * broker, which already keeps them, settles their waiters and fans them out;
 * the inbox reads them from it and answers them through it. Everything else a
 * subsystem or an agent needs from the owner (a question, a channel claim, a
 * purchase window, an action queued while he was away) is posted here and kept
 * in the question store, a record log.
 *
 * The daemon owns the one instance. The terminal apps and the web UI reach it
 * through the `inbox.*` verbs; in-process producers call it directly. The first
 * answer wins; a later one changes nothing and is told who answered, from where.
 *
 * Cost: a tool call that queues nothing costs nothing here. A post or an answer
 * is one synced append (approvals: the broker's own write). A list is a walk of
 * in-memory maps. `revision()` is an integer read.
 */
import { refusal, type Refusal } from '@goodvibes-jev/engine/errors';
import type { ApprovalBroker, SharedApprovalRecord } from './approval-broker.js';
import type { ApprovalActionOutcome } from './approval-broker-owner.js';
import { QuestionStore, type StoredOwnerEntry, type StoredOwnerItem, type StoredOwnerItemKind } from './question-store.js';
import type { RevisionSource } from '../utils/revision.js';
import { logger } from '../utils/logger.js';

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

export type OwnerAnswerOutcome =
  | { readonly applied: true; readonly item: OwnerItem }
  | { readonly applied: false; readonly item?: OwnerItem | undefined; readonly refusal: Refusal };

export type OwnerPostOutcome =
  | { readonly created: boolean; readonly item: OwnerItem };

export type OwnerInboxListener = (item: OwnerItem) => void;

/** The part of the approval broker the inbox reads and answers through. */
export type OwnerInboxApprovalSource = Pick<ApprovalBroker, 'listApprovals' | 'getApproval' | 'resolveApproval' | 'subscribe'>;

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

function projectStored(entry: StoredOwnerEntry, now: number): OwnerItem {
  const { item } = entry;
  const status = storedStatus(entry, now);
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
  readonly now?: (() => number) | undefined;
}

export class OwnerInbox implements RevisionSource, OwnerInboxPort {
  readonly id = 'owner inbox';
  readonly #questions: QuestionStore;
  readonly #approvals: OwnerInboxApprovalSource | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<OwnerInboxListener>();
  readonly #unsubscribeApprovals: (() => void) | undefined;
  #approvalRevision = 0;

  constructor(options: OwnerInboxOptions) {
    this.#questions = options.questions;
    this.#approvals = options.approvals;
    this.#now = options.now ?? Date.now;
    this.#unsubscribeApprovals = this.#approvals?.subscribe((record) => {
      this.#approvalRevision += 1;
      this.#emit(projectApproval(record));
    });
  }

  /** Moves on every post, answer and withdrawal, and on every approval change. Expiry by time does not move it. */
  revision(): number {
    return this.#questions.revision() + this.#approvalRevision;
  }

  get(id: string): OwnerItem | undefined {
    const entry = this.#questions.get(id);
    if (entry) return projectStored(entry, this.#now());
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
      const item = projectStored(entry, now);
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
    if (item.key !== undefined) {
      const existing = this.#questions.findOpen(item.kind, item.key);
      if (existing && storedStatus(existing, now) === 'open') return { created: false, item: projectStored(existing, now) };
    }
    const entry = this.#questions.post({ ...item, ...(postedBy !== undefined ? { postedBy } : {}) }, now);
    const projected = projectStored(entry, now);
    this.#emit(projected);
    return { created: true, item: projected };
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
      const item = projectStored(entry, now);
      if (item.status !== 'open') return { applied: false, item, refusal: closedRefusal(item) };
      const checked = this.#checkAnswer(item, answer);
      if ('refusal' in checked) return { applied: false, item, refusal: checked.refusal };
      const result = this.#questions.answer(id, checked.answer, by, now);
      if (!result) return { applied: false, refusal: unknownRefusal(id) };
      const answered = projectStored(result.entry, now);
      if (!result.applied) return { applied: false, item: answered, refusal: closedRefusal(answered) };
      this.#emit(answered);
      return { applied: true, item: answered };
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
    const item = projectStored(result.entry, now);
    if (!result.applied) return { applied: false, item, refusal: closedRefusal(item) };
    this.#emit(item);
    return { applied: true, item };
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
    for (const listener of [...this.#listeners]) {
      try {
        listener(item);
      } catch (error) {
        logger.warn('[owner-inbox] a listener failed', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

/** Build the inbox over a composition's approval broker and its question log at `questionsPath`. */
export function createOwnerInbox(options: {
  readonly questionsPath: string;
  readonly approvals?: OwnerInboxApprovalSource | undefined;
  readonly now?: (() => number) | undefined;
}): OwnerInbox {
  return new OwnerInbox({
    questions: new QuestionStore({ path: options.questionsPath }),
    ...(options.approvals !== undefined ? { approvals: options.approvals } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

const ITEM_STATUSES: ReadonlySet<string> = new Set<OwnerItemStatus>(['open', 'answered', 'withdrawn', 'expired']);
const ITEM_KINDS: ReadonlySet<string> = new Set<string>(OWNER_ITEM_KINDS);

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
  return record as unknown as OwnerItem;
}
