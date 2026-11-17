/**
 * Questions agents left the owner (the daemon's owner inbox, `inbox.list`),
 * answered here with `inbox.answer`. The first answer from any surface wins; a
 * question already answered elsewhere says so instead of taking a second one.
 * An answer goes back to the agent or session that asked: the toast says
 * whether it was delivered, waits for that session to be opened again, or
 * cannot reach it and why, and recent answers are listed with that state.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { RowGroup } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { Input } from '../../components/ui/Field';
import type { StatusTone } from '../../components/ui/StatusDot';

const QUESTIONS_QUERY_KEY = ['owner-inbox', 'questions', 'open'] as const;
const ANSWERS_QUERY_KEY = ['owner-inbox', 'questions', 'closed'] as const;
/** Recent answers shown with where they are; older ones are in /decisions. */
const ANSWERS_SHOWN = 20;

interface OwnerQuestion {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly options: readonly string[];
  readonly askedBy?: string;
  readonly createdAt: number;
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

type AnswerOutcome =
  | { readonly applied: true; readonly delivery?: unknown }
  | { readonly applied: false; readonly refusal: { readonly reason: string; readonly next?: readonly string[] } };

function readQuestions(value: unknown): OwnerQuestion[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw): OwnerQuestion[] => {
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || item.kind !== 'question' || item.status !== 'open') return [];
    return [{
      id: item.id,
      title: item.title,
      ...(typeof item.detail === 'string' && item.detail ? { detail: item.detail } : {}),
      options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : [],
      ...(typeof item.askedBy === 'string' && item.askedBy ? { askedBy: item.askedBy } : {}),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    }];
  });
}

function QuestionRow({ question, onAnswer, busy }: {
  question: OwnerQuestion;
  onAnswer: (answer: { option?: string; text?: string }) => void;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const asked = question.createdAt ? new Date(question.createdAt).toLocaleString() : '';
  return (
    <li className="gv-row work-question">
      <div className="gv-row__text work-question__body">
        <div className="gv-row__title">{question.title}</div>
        <div className="gv-row__meta">{[question.askedBy, asked].filter(Boolean).join(' · ')}</div>
        {question.detail && <p className="work-question__detail">{question.detail}</p>}
        <form
          className="work-question__answer"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) onAnswer({ text: text.trim() });
          }}
        >
          {question.options.map((option) => (
            <Button key={option} size="sm" disabled={busy} onClick={() => onAnswer({ option })}>{option}</Button>
          ))}
          <Input
            aria-label={`Answer ${question.title}`}
            placeholder={question.options.length > 0 ? 'Or answer in your own words' : 'Your answer'}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !text.trim()}>Send</Button>
        </form>
      </div>
    </li>
  );
}

/**
 * "Questions for you": open questions from agents, answerable in place, and
 * the recent answers with where each one is. Renders nothing when there are none.
 */
export function OwnerQuestions({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const questions = useQuery({
    queryKey: QUESTIONS_QUERY_KEY,
    queryFn: async () => readQuestions(await platformClient.operator.invoke('inbox.list', { status: 'open', kinds: ['question'] })),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
  const answers = useQuery({
    queryKey: ANSWERS_QUERY_KEY,
    queryFn: async () => readAnswered(await platformClient.operator.invoke('inbox.list', { status: 'closed', kinds: ['question'], limit: ANSWERS_SHOWN })),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
  const answer = useMutation({
    mutationFn: async (input: { itemId: string; option?: string; text?: string }) =>
      (await platformClient.operator.invoke('inbox.answer', input)) as AnswerOutcome,
    onSuccess: (outcome) => {
      const delivery = outcome.applied ? readDelivery(outcome.delivery) : undefined;
      if (!outcome.applied) {
        toast({ title: 'Not sent', description: [outcome.refusal.reason, outcome.refusal.next?.[0]].filter(Boolean).join(' '), tone: 'warning' });
      } else if (delivery?.state === 'undeliverable') {
        toast({ title: 'Answer saved, not deliverable', description: `Not deliverable to ${delivery.to}: ${delivery.reason ?? 'it cannot be opened again.'}`, tone: 'warning' });
      } else if (delivery?.state === 'waiting') {
        toast({ title: 'Answer saved', description: delivery.reason ?? `It will be delivered when ${delivery.to} is next opened.`, tone: 'success' });
      } else {
        toast({ title: 'Answer sent', description: delivery ? `Sent to ${delivery.to}; it reads it on its next step.` : 'The asker reads it on its next step.', tone: 'success' });
      }
    },
    onError: (error) => toast({ title: 'The answer was not sent', description: formatError(error), tone: 'danger' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUESTIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ANSWERS_QUERY_KEY });
    },
  });
  const open = enabled ? questions.data ?? [] : [];
  const answered = enabled ? answers.data ?? [] : [];
  if (open.length === 0 && answered.length === 0) return null;
  return (
    <>
      {open.length > 0 && (
        <RowGroup label="Questions for you" count={open.length}>
          {open.map((question) => (
            <QuestionRow
              key={question.id}
              question={question}
              busy={answer.isPending}
              onAnswer={(input) => answer.mutate({ itemId: question.id, ...input })}
            />
          ))}
        </RowGroup>
      )}
      {answered.length > 0 && (
        <RowGroup label="Your answers" count={answered.length}>
          {answered.map((question) => <AnsweredRow key={question.id} question={question} />)}
        </RowGroup>
      )}
    </>
  );
}
