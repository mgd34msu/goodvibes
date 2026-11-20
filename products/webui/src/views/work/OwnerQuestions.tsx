/**
 * What became of the owner inbox's questions once answered (the daemon's owner
 * inbox, `inbox.list`): recent answers, each with whether it reached the agent
 * or session that asked, waits for it to be opened again, or cannot reach it
 * and why. Open questions are not listed here: they wait for you on the work
 * board with every other ask, answered from their card (AskCard).
 *
 * Calls Jev decided for the owner at the permission gate (kind `decision`)
 * are listed too, with a button per choice still open: undo restores the
 * files the call changed, never, always and ask set a standing rule for calls
 * like it, keep leaves it. The app whose gate decided carries the choice out;
 * the toast says what was done, or why it could not be.
 *
 * One `inbox.list` read carries both lists. It is re-read when an
 * `owner-inbox-update` frame arrives on the shared event stream
 * (useRealtimeInvalidation) and polled only while that stream is not live.
 */
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { OperatorMethodInput } from '@goodvibes-jev/engine/contracts';
import { client as platformClient } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { useEventStreamState } from '../../lib/event-stream';
import { queryKeys } from '../../lib/queries';
import { useToast } from '../../lib/toast';
import { RowGroup } from '../../components/data-view/DataView';
import { Row } from '../../components/ui/Row';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import type { StatusTone } from '../../components/ui/StatusDot';

const INBOX_QUERY_KEY = [...queryKeys.ownerInbox, 'questions-and-decisions'] as const;
/** Answers (and decisions) shown at first, and how many more each "Show older" adds. */
const ANSWERS_SHOWN = 20;
/** One inbox.list page; "Show older" reads the next one with its cursor once the read ones are shown. */
const LIST_LIMIT = 100;
/** Poll cadence while the event stream is not live; while it is, frames refresh the list. */
const FALLBACK_POLL_MS = 30_000;

interface InboxLists {
  readonly answered: AnsweredQuestion[];
  readonly decisions: JevDecision[];
}

function itemsOf(value: unknown): unknown[] {
  const items = (value as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

interface InboxPage extends InboxLists {
  /** The cursor of the next (older) page, when there is one. */
  readonly nextCursor?: string;
}

/** One page of answers and Jev's decisions, newest first, split here. */
async function readInboxPage(cursor: string): Promise<InboxPage> {
  // A report (the answer of a scheduled run or a trigger's turn that named no surface) is answered `read`.
  const kinds = ['question', 'report', 'decision'] as const;
  // `cursor` is on inbox.list's schema; the generated input type gains it when the contract is regenerated.
  const input: OperatorMethodInput<'inbox.list'> & { readonly cursor?: string } = {
    status: 'all', kinds, limit: LIST_LIMIT, ...(cursor ? { cursor } : {}),
  };
  const answer = await platformClient.operator.invoke('inbox.list', input);
  const page = { items: itemsOf(answer) };
  const next = (answer as { nextCursor?: unknown } | null)?.nextCursor;
  return {
    answered: readAnswered(page),
    decisions: readDecisions(page),
    ...(typeof next === 'string' && next ? { nextCursor: next } : {}),
  };
}

interface AnswerDelivery {
  readonly state: 'delivered' | 'waiting' | 'undeliverable';
  readonly to: string;
  readonly reason?: string;
}

interface AnsweredQuestion {
  readonly id: string;
  readonly title: string;
  readonly answer: string;
  readonly delivery: AnswerDelivery;
}

const DELIVERY_STATES = new Set(['delivered', 'waiting', 'undeliverable']);

function readDelivery(value: unknown): AnswerDelivery | undefined {
  const delivery = value as Record<string, unknown> | null | undefined;
  if (!delivery || typeof delivery.state !== 'string' || !DELIVERY_STATES.has(delivery.state) || typeof delivery.to !== 'string') return undefined;
  return {
    state: delivery.state as AnswerDelivery['state'],
    to: delivery.to,
    ...(typeof delivery.reason === 'string' && delivery.reason ? { reason: delivery.reason } : {}),
  };
}

/** Answered questions whose answer has an asker to reach, newest first. */
function readAnswered(value: unknown): AnsweredQuestion[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw): AnsweredQuestion[] => {
    const item = raw as Record<string, unknown>;
    const delivery = readDelivery(item.delivery);
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || item.kind !== 'question' || item.status !== 'answered' || !delivery) return [];
    const answer = item.answer as { option?: unknown; text?: unknown } | undefined;
    const words = [answer?.option, answer?.text].filter((part): part is string => typeof part === 'string' && part.length > 0).join(': ');
    return [{ id: item.id, title: item.title, answer: words, delivery }];
  });
}

const DELIVERY_TONE: Record<AnswerDelivery['state'], StatusTone> = { delivered: 'ok', waiting: 'info', undeliverable: 'warn' };

function deliveryLabel(delivery: AnswerDelivery): string {
  if (delivery.state === 'delivered') return `Delivered to ${delivery.to}`;
  if (delivery.state === 'waiting') return `Waiting for ${delivery.to}`;
  return `Not deliverable to ${delivery.to}`;
}

function AnsweredRow({ question }: { question: AnsweredQuestion }) {
  const { delivery } = question;
  return (
    <li className="gv-row work-question">
      <div className="gv-row__text work-question__body">
        <div className="gv-row__title">{question.title}</div>
        <div className="gv-row__meta">{question.answer}</div>
        <Chip size="sm" tone={DELIVERY_TONE[delivery.state]}>{deliveryLabel(delivery)}</Chip>
        {delivery.state !== 'delivered' && delivery.reason && <p className="work-question__detail">{delivery.reason}</p>}
      </div>
    </li>
  );
}

interface JevDecision {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly options: readonly string[];
  readonly open: boolean;
  /** What was done, or why it was closed, once it is no longer open. */
  readonly outcome?: string;
  readonly createdAt: number;
}

/** Jev's decisions, newest first: open ones take a choice, closed ones say what became of them. */
function readDecisions(value: unknown): JevDecision[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw): JevDecision[] => {
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || item.kind !== 'decision') return [];
    const answer = item.answer as { option?: unknown; text?: unknown } | undefined;
    const outcome = typeof answer?.text === 'string' && answer.text ? answer.text
      : typeof answer?.option === 'string' ? answer.option
        : typeof item.withdrawnReason === 'string' && item.withdrawnReason ? item.withdrawnReason
          : item.status === 'expired' ? 'Expired; set a standing rule in settings instead.' : undefined;
    return [{
      id: item.id,
      title: item.title,
      ...(typeof item.detail === 'string' && item.detail ? { detail: item.detail } : {}),
      options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : [],
      open: item.status === 'open',
      ...(outcome !== undefined ? { outcome } : {}),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    }];
  });
}

function DecisionRow({ decision, onChoose, busy }: {
  decision: JevDecision;
  onChoose: (option: string) => void;
  busy: boolean;
}) {
  const decided = decision.createdAt ? new Date(decision.createdAt).toLocaleString() : '';
  return (
    <li className="gv-row work-question">
      <div className="gv-row__text work-question__body">
        <div className="gv-row__title">{decision.title}</div>
        <div className="gv-row__meta">{decided}</div>
        {decision.detail && <p className="work-question__detail">{decision.detail}</p>}
        {decision.open ? (
          <div className="work-question__answer">
            {decision.options.map((option) => (
              <Button key={option} size="sm" disabled={busy} onClick={() => onChoose(option)}>{option}</Button>
            ))}
          </div>
        ) : decision.outcome && <Chip size="sm" tone="info">{decision.outcome}</Chip>}
      </div>
    </li>
  );
}

type DecisionOutcome =
  | { readonly applied: true; readonly item?: { readonly answer?: { readonly text?: string } } }
  | { readonly applied: false; readonly refusal: { readonly reason: string; readonly next?: readonly string[] } };

/** Recent answers with where each one is, and Jev's decisions. Renders nothing when there are none. */
export function OwnerQuestions({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const streamLive = useEventStreamState('app').status === 'live';
  const inbox = useInfiniteQuery({
    queryKey: INBOX_QUERY_KEY,
    initialPageParam: '',
    queryFn: ({ pageParam }) => readInboxPage(pageParam),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    refetchInterval: streamLive ? false : FALLBACK_POLL_MS,
    retry: false,
  });
  // How many of each list are shown; "Show older" adds a screenful and reads the next page when the read ones run out.
  const [shown, setShown] = useState(ANSWERS_SHOWN);
  const choose = useMutation({
    mutationFn: async (input: { itemId: string; option: string }) =>
      (await platformClient.operator.invoke('inbox.answer', input)) as DecisionOutcome,
    onSuccess: (outcome) => {
      if (!outcome.applied) {
        toast({ title: 'Not done', description: [outcome.refusal.reason, outcome.refusal.next?.[0]].filter(Boolean).join(' '), tone: 'warning' });
      } else {
        toast({ title: 'Done', description: outcome.item?.answer?.text ?? 'Your choice was carried out.', tone: 'success' });
      }
    },
    onError: (error) => toast({ title: 'The choice was not sent', description: formatError(error), tone: 'danger' }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY }); },
  });
  const pages = enabled ? inbox.data?.pages ?? [] : [];
  const answered = pages.flatMap((page) => page.answered);
  const decided = pages.flatMap((page) => page.decisions);
  if (answered.length === 0 && decided.length === 0) return null;
  const more = Boolean(inbox.hasNextPage);
  const showOlder = (): void => {
    setShown((count) => count + ANSWERS_SHOWN);
    if (more && !inbox.isFetchingNextPage) void inbox.fetchNextPage();
  };
  const olderRow = (label: string, hidden: number) => (hidden > 0 || more) && (
    <Row
      title={inbox.isFetchingNextPage ? 'Loading…' : `Show older ${label}`}
      meta={hidden > 0 ? `${hidden}${more ? '+' : ''} more` : undefined}
      onSelect={inbox.isFetchingNextPage ? undefined : showOlder}
    />
  );
  return (
    <>
      {answered.length > 0 && (
        <RowGroup label="Your answers" count={answered.length}>
          {answered.slice(0, shown).map((question) => <AnsweredRow key={question.id} question={question} />)}
          {olderRow('answers', answered.length - Math.min(shown, answered.length))}
        </RowGroup>
      )}
      {decided.length > 0 && (
        <RowGroup label="Decided for you by Jev" count={decided.length}>
          {decided.slice(0, shown).map((decision) => (
            <DecisionRow
              key={decision.id}
              decision={decision}
              busy={choose.isPending}
              onChoose={(option) => choose.mutate({ itemId: decision.id, option })}
            />
          ))}
          {olderRow('decisions', decided.length - Math.min(shown, decided.length))}
        </RowGroup>
      )}
    </>
  );
}
