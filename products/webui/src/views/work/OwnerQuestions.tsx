/**
 * Questions agents left the owner (the daemon's owner inbox, `inbox.list`),
 * answered here with `inbox.answer`. The first answer from any surface wins; a
 * question already answered elsewhere says so instead of taking a second one.
 * The asking agent hears the answer on its next request.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { RowGroup } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';

const QUESTIONS_QUERY_KEY = ['owner-inbox', 'questions', 'open'] as const;

interface OwnerQuestion {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly options: readonly string[];
  readonly askedBy?: string;
  readonly createdAt: number;
}

type AnswerOutcome =
  | { readonly applied: true }
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

/** "Questions for you": open questions from agents, answerable in place. Renders nothing when there are none. */
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
  const answer = useMutation({
    mutationFn: async (input: { itemId: string; option?: string; text?: string }) =>
      (await platformClient.operator.invoke('inbox.answer', input)) as AnswerOutcome,
    onSuccess: (outcome) => {
      if (outcome.applied) toast({ title: 'Answer sent', description: 'The agent reads it on its next step.', tone: 'success' });
      else toast({ title: 'Not sent', description: [outcome.refusal.reason, outcome.refusal.next?.[0]].filter(Boolean).join(' '), tone: 'warning' });
    },
    onError: (error) => toast({ title: 'The answer was not sent', description: formatError(error), tone: 'danger' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QUESTIONS_QUERY_KEY }),
  });
  const open = enabled ? questions.data ?? [] : [];
  if (open.length === 0) return null;
  return (
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
  );
}
