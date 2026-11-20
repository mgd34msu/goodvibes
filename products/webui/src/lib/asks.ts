/**
 * The asks waiting for the person, as this client reads them off the wire:
 * approvals (`approvals.list`, each with its reading and presentation) and the
 * owner inbox's other open items (`inbox.list`: a question, a purchase window,
 * a channel claim, an action held for the owner, a report), each with the
 * presentation the daemon words it in (platform/permissions/ask-presentation.ts).
 *
 * Work's rows and ask detail, the chat's inline card and the sidebar badge all
 * read these, and none of them words an ask itself: the question, the
 * consequence, the choices and the details are the presentation's. A record
 * from a daemon that sends no presentation is shown by its own title and its
 * own options, nothing more.
 *
 * Pure: projections of the fetched records.
 */
import type { AskChoice, AskPresentation } from '@goodvibes/engine/platform/platform/permissions';
import type { WorkBoardAsk } from '@goodvibes/engine/contracts';
import type { ApprovalRecord } from './goodvibes';
import { approvalReading, isActionableApproval, type ApprovalReading } from './approvals';

export type { AskChoice, AskPresentation };

/** The inbox kinds that wait on the person (decisions Jev made are listed apart, never as waiting). */
export const INBOX_ASK_KINDS = ['question', 'claim', 'purchase', 'queued-action', 'report'] as const;

/** One open owner-inbox item, read defensively. */
export interface InboxAskItem {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly sessionId?: string;
  readonly title: string;
  readonly detail: string;
  readonly options: readonly string[];
  readonly askedBy?: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly presentation?: AskPresentation;
}

/** One ask, wherever it came from. */
export interface OpenAsk {
  /** `approval:<id>` or `inbox:<id>`: the Work key of its detail. */
  readonly key: string;
  readonly source: 'approval' | 'inbox';
  readonly id: string;
  readonly sessionId?: string;
  /** The agent that asked, for an approval a background agent raised. */
  readonly agentId?: string;
  readonly askedAt: number;
  readonly presentation: AskPresentation;
  /** False when the daemon sent no presentation and the record's own words stand in. */
  readonly worded: boolean;
  readonly approval?: ApprovalRecord;
  readonly item?: InboxAskItem;
}

function isPresentation(value: unknown): value is AskPresentation {
  const p = value as Partial<AskPresentation> | null | undefined;
  return Boolean(p) && typeof p?.question === 'string' && typeof p.title === 'string' && Array.isArray(p.choices) && Array.isArray(p.details);
}

/** The presentation a record carries on the wire, when it carries one. */
export function wirePresentation(record: unknown): AskPresentation | undefined {
  const value = (record as { presentation?: unknown } | null | undefined)?.presentation;
  return isPresentation(value) ? value : undefined;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

/**
 * The record's own words, for a daemon that sent no presentation: its title as
 * the question, its options as the choices, everything else behind Details.
 */
function standInPresentation(input: {
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly choices: readonly AskChoice[];
  readonly details: readonly { label: string; value: string }[];
}): AskPresentation {
  return {
    kind: input.kind === 'question' ? 'question' : 'other-tool',
    mark: input.kind === 'question' ? 'question' : 'ask',
    question: input.title,
    ...(input.detail ? { body: firstLine(input.detail) } : {}),
    choices: input.choices,
    remember: { offered: false, why: 'answered once' },
    typeToRefuse: false,
    why: '',
    details: input.details,
    title: input.title,
  };
}

function approvalStandIn(record: ApprovalRecord): AskPresentation {
  const request = record.request;
  const title = request.analysis.summary.trim() || request.tool;
  return standInPresentation({
    kind: 'approval',
    title,
    detail: '',
    choices: [{ id: 'once', label: 'Yes, once', default: true }, { id: 'no', label: 'No' }],
    details: [{ label: 'Tool', value: request.tool }, { label: 'Arguments', value: JSON.stringify(request.args) }],
  });
}

function inboxStandIn(item: InboxAskItem): AskPresentation {
  const options = item.options.map((option, index): AskChoice => ({ id: `option:${index}`, label: option, value: option, ...(index === 0 ? { default: true as const } : {}) }));
  return standInPresentation({
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    choices: options.length > 0 ? options : [{ id: 'own-words', label: 'Answer in your own words', default: true }],
    details: item.detail ? [{ label: 'Detail', value: item.detail }] : [],
  });
}

/**
 * One approval as an ask, whatever its phase (Work's detail shows a decided one
 * too). Its words are the presentation its `approvals.list` row carries (or its
 * `approval-update` frame), else, from a daemon that sends none, the record's own summary.
 */
export function approvalAsk(record: ApprovalRecord): OpenAsk {
  const worded = wirePresentation(record);
  const attribution = record.request.attribution;
  return {
    key: `approval:${record.id}`,
    source: 'approval',
    id: record.id,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(attribution?.kind === 'background-agent' ? { agentId: attribution.agentId } : {}),
    askedAt: record.createdAt,
    presentation: worded ?? approvalStandIn(record),
    worded: worded !== undefined,
    approval: record,
  };
}

/** Approvals still waiting, as asks: each worded by the presentation its `approvals.list` row carries. */
export function approvalAsks(records: readonly ApprovalRecord[]): OpenAsk[] {
  return records.filter((record) => approvalReading(record).phase === 'waiting').map((record) => approvalAsk(record));
}

/** The open ask items of an `inbox.list` page (approvals come from `approvals.list`). */
export function readInboxAskItems(page: unknown): InboxAskItem[] {
  const items = (page as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const kinds: ReadonlySet<string> = new Set(INBOX_ASK_KINDS);
  return items.flatMap((raw): InboxAskItem[] => {
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.kind !== 'string' || !kinds.has(item.kind) || item.status !== 'open') return [];
    const presentation = wirePresentation(item);
    return [{
      id: item.id,
      kind: item.kind,
      status: item.status,
      ...(typeof item.sessionId === 'string' && item.sessionId ? { sessionId: item.sessionId } : {}),
      title: item.title,
      detail: typeof item.detail === 'string' ? item.detail : '',
      options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : [],
      ...(typeof item.askedBy === 'string' && item.askedBy ? { askedBy: item.askedBy } : {}),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
      ...(typeof item.expiresAt === 'number' ? { expiresAt: item.expiresAt } : {}),
      ...(presentation ? { presentation } : {}),
    }];
  });
}

export function inboxAsks(items: readonly InboxAskItem[]): OpenAsk[] {
  return items.map((item): OpenAsk => ({
    key: `inbox:${item.id}`,
    source: 'inbox',
    id: item.id,
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    askedAt: item.createdAt,
    presentation: item.presentation ?? inboxStandIn(item),
    worded: item.presentation !== undefined,
    item,
  }));
}

/** Every open ask, newest first. */
export function openAsks(approvals: readonly ApprovalRecord[], inboxItems: readonly InboxAskItem[]): OpenAsk[] {
  return [...approvalAsks(approvals), ...inboxAsks(inboxItems)].sort((a, b) => b.askedAt - a.askedAt);
}

/** An ask as the work board reads it. */
export function boardAsk(ask: OpenAsk): WorkBoardAsk {
  const p = ask.presentation;
  return {
    id: ask.key,
    askedAt: ask.askedAt,
    ...(ask.sessionId ? { sessionId: ask.sessionId } : {}),
    ...(ask.agentId ? { agentId: ask.agentId } : {}),
    presentation: {
      kind: p.kind,
      title: p.title,
      ...(p.consequence ? { consequence: { text: p.consequence.text, tone: p.consequence.tone } } : {}),
      ...(p.countdown ? { countdown: p.countdown } : {}),
      ...(p.origin ? { origin: p.origin } : {}),
    },
  };
}

/** The reading of an approval ask, when it is one. */
export function askReading(ask: OpenAsk): ApprovalReading | undefined {
  return ask.approval ? approvalReading(ask.approval) : undefined;
}

/** Whether this person may answer the ask now: an approval by its reading, an inbox item while it is open. */
export function isAnswerable(ask: OpenAsk): boolean {
  return ask.approval ? isActionableApproval(ask.approval) : ask.item?.status === 'open';
}

/** "Waiting for you", "Decided by Sam on the phone", "Ended: the asking session closed": an approval's state, from its reading. */
export function readingStateLine(reading: ApprovalReading): string {
  if (reading.phase === 'waiting') {
    if (reading.reason === 'claimed-by-you') return 'Waiting for you · you said you would handle it';
    if (reading.reason === 'claimed-by-other') return `Waiting · ${reading.waitingOn?.claimedBy ?? 'someone else'} is handling it`;
    return reading.waitingOn?.homeReachable === false ? 'Waiting for you · the computer that asked is not answering' : 'Waiting for you';
  }
  const decision = reading.decision;
  const on = decision && decision.surface !== 'unknown surface' ? ` on ${surfaceWords(decision.surface)}` : '';
  switch (reading.reason) {
    case 'approved':
    case 'denied':
    case 'amended':
      return decision ? `Decided by ${decision.by}${on}` : 'Decided';
    case 'remembered-approved':
    case 'remembered-denied':
      return 'Decided by a rule you set';
    case 'cancelled-requester-left': return 'Ended: the asking session closed';
    case 'cancelled-requester-restarted': return 'Ended: the asking program restarted';
    case 'cancelled-owner-decision-stale': return 'Ended: it waited too long for the device that raised it';
    case 'cancelled-by-actor': return decision ? `Ended: cancelled by ${decision.by}` : 'Ended: cancelled';
    case 'expired': return 'Ended: no one answered in time';
    case 'expired-while-down': return 'Ended: its time ran out while GoodVibes was stopped';
    default: return 'Ended';
  }
}

/** A surface name as people say it: "the phone", "the web UI", "the terminal app". */
function surfaceWords(surface: string): string {
  const s = surface.toLowerCase();
  if (s.includes('phone') || s.includes('push') || s.includes('mobile')) return 'the phone';
  if (s.includes('web')) return 'the web UI';
  if (s.includes('tui') || s.includes('terminal')) return 'the terminal app';
  if (s.includes('agent')) return 'the Agent';
  if (s.includes('telegram') || s.includes('slack') || s.includes('discord') || s.includes('ntfy')) return surface;
  return surface;
}
