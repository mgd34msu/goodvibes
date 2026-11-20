/**
 * One ask as a card (ux A2.4, A2.5): the question in a sentence, what it acts
 * on, what it will do, the choices, and everything else behind "Why am I
 * asked?" and "Details". Drawn inline in the chat that is waiting and in Work's
 * ask detail, from the ask's presentation alone (lib/asks.ts); it builds no
 * words for a fact the presentation carries.
 *
 * Choices: the default one is the primary button. "Don't ask again…" opens the
 * remember tiers as radio rows (Allow and remember / Back); "No" on an ask that
 * takes a reason opens an optional reason field (Refuse / Back). An ask that
 * can't be undone draws its border and consequence in --bad and offers no
 * remembering, saying so beside the buttons. A question shows its options as
 * buttons and "Answer in your own words". A file change keeps its hunk
 * selection ("Apply selected"); a command waiting on its terminal takes the
 * reply it is sent.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { agoWords } from '@goodvibes-jev/engine/contracts';
import { hunkSummary, readApprovalEditHunks, readExecPromptAsk } from '../../lib/approvals';
import { askReading, isAnswerable, type AskChoice, type OpenAsk } from '../../lib/asks';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Input } from '../../components/ui/Field';
import { Radio } from '../../components/ui/Radio';
import type { AskActions } from './useAskActions';
import '../../styles/components/ask-card.css';

/** What the person chose, as the collapsed line says it: "You said yes once · 2:41 pm". */
export interface DecidedWords {
  readonly words: string;
  readonly at: number;
}

/** A clock time the way the collapsed line shows it: "2:41 pm". */
export function clockWords(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

/** "Asked by the agent in "Tidy the seed notes"", "From "Plan the spring garden beds"": who asked, from where. */
export function originWords(ask: OpenAsk): string | undefined {
  const origin = ask.presentation.origin;
  if (!origin) return undefined;
  if (origin.sessionTitle !== undefined) return ask.presentation.kind === 'purchase' ? `From "${origin.sessionTitle}"` : `Asked by ${origin.by} in "${origin.sessionTitle}"`;
  return `Asked by ${origin.by}`;
}

/** A purchase window's deadline: "goes ahead in 9 min unless you say no" | "waits for you until 14:05". */
export function countdownWords(ask: OpenAsk, now: number): string | undefined {
  const countdown = ask.presentation.countdown;
  if (!countdown) return undefined;
  if (countdown.verb === 'goes ahead') return `goes ahead in ${Math.max(0, Math.ceil((countdown.at - now) / 60_000))} min unless you say no`;
  const until = new Date(countdown.at);
  return `${countdown.verb} until ${until.getHours()}:${String(until.getMinutes()).padStart(2, '0')}`;
}

function capitalized(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

/** The web's label for a choice: the remember choice reads "Don't ask again…" (A2.4), a question's free answer "Answer in your own words". */
function choiceLabel(choice: AskChoice, question: boolean): string {
  if (choice.id === 'remember') return 'Don\'t ask again…';
  if (choice.id === 'own-words' && question) return 'Answer in your own words';
  return choice.label;
}

type Mode = { readonly step: 'choose' } | { readonly step: 'remember' } | { readonly step: 'refuse'; readonly choice: AskChoice } | { readonly step: 'own-words'; readonly choice: AskChoice };

export interface AskCardProps {
  ask: OpenAsk;
  actions: AskActions;
  /** `inline` in a chat (amber border, message width); `detail` in Work's pane. */
  variant: 'inline' | 'detail';
  /** Rows Work adds to Details (who asked, the session, the decision trail). */
  extraDetails?: readonly { label: string; value: ReactNode }[];
  /** Called once a choice was recorded, with the words the collapsed line shows. */
  onDecided?: (ask: OpenAsk, decided: DecidedWords) => void;
  /** Shown above the question (Work: who asked and when). */
  lead?: ReactNode;
}

export function AskCard({ ask, actions, variant, extraDetails = [], onDecided, lead }: AskCardProps) {
  const p = ask.presentation;
  const record = ask.approval;
  const cannotUndo = p.mark === 'cannot-undo';
  const question = p.kind === 'question' || p.kind === 'decision';
  const answerable = isAnswerable(ask);
  // Why this person cannot answer an ask that still waits, in the daemon's words (the reading's refusal).
  const reading = askReading(ask);
  const refused = !answerable && reading?.phase === 'waiting'
    ? reading.refusedActions.find((entry) => entry.action === 'approve' || entry.action === 'deny')?.reason
    : undefined;
  const hunks = useMemo(() => (record ? readApprovalEditHunks(record) : null), [record]);
  const execPrompt = useMemo(() => (record ? readExecPromptAsk(record) : null), [record]);

  const [mode, setMode] = useState<Mode>({ step: 'choose' });
  const [rememberTier, setRememberTier] = useState(p.remember.offered ? p.remember.tiers[0]?.tier ?? '' : '');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(hunks?.map((_, index) => index) ?? []));
  const [execAnswer, setExecAnswer] = useState('');
  const [open, setOpen] = useState<'why' | 'details' | null>(null);
  const busy = actions.busy;

  const decided = (words: string) => onDecided?.(ask, { words, at: Date.now() });

  const run = (choice: AskChoice, extra: { text?: string; rememberTier?: string } = {}) => {
    if (choice.id === 'remember' && extra.rememberTier === undefined) { setMode({ step: 'remember' }); return; }
    if (choice.id === 'no' && p.typeToRefuse && extra.text === undefined) { setMode({ step: 'refuse', choice }); return; }
    if (choice.id === 'own-words' && extra.text === undefined) { setMode({ step: 'own-words', choice }); return; }
    const selectedHunks = choice.id === 'apply-selected' && hunks ? [...selected].sort((a, b) => a - b) : undefined;
    if (selectedHunks && selectedHunks.length === 0) return;
    const answer = p.kind === 'answer-command-prompt' && choice.id === 'once' ? execAnswer : undefined;
    actions.choose(ask, choice, {
      ...(extra.text !== undefined ? { text: extra.text } : {}),
      ...(extra.rememberTier ? { rememberTier: extra.rememberTier } : {}),
      ...(selectedHunks ? { selectedHunks, totalHunks: hunks?.length } : {}),
      ...(answer !== undefined ? { answer } : {}),
    });
    const reason = extra.text?.trim();
    decided(
      choice.id === 'once' && p.kind === 'answer-command-prompt' ? 'You sent the answer'
        : choice.id === 'once' && record ? 'You said yes once'
          : choice.id === 'remember' ? 'You said yes and not to ask again'
            : choice.id === 'apply-selected' ? `You applied ${selectedHunks?.length ?? 0} of ${hunks?.length ?? 0} changes`
              : choice.id === 'no' && record ? `You said no${reason ? `: ${reason}` : ''}`
                : choice.id === 'own-words' ? `Answered: ${reason ?? ''}`
                  : `Answered: ${choice.label}`,
    );
    setMode({ step: 'choose' });
  };

  const primary = p.choices.find((choice) => choice.default) ?? p.choices[0];

  const subject = p.subject && p.subject.lines.length > 0 ? (
    p.subject.kind === 'command' || p.subject.kind === 'paths' || p.subject.kind === 'urls' ? (
      <div className="ask-card__subject">
        {p.subject.lines.map((line, index) => <code key={index} className="ask-card__code">{line}</code>)}
      </div>
    ) : (
      <div className="ask-card__subject ask-card__subject--text">
        {p.subject.lines.map((line, index) => <p key={index}>{line}</p>)}
      </div>
    )
  ) : null;

  const consequence = p.consequence ? (
    <p className={`ask-card__consequence${p.consequence.tone === 'cannot-undo' ? ' ask-card__consequence--undo' : ''}`}>
      {p.consequence.withPlace || p.consequence.text}
    </p>
  ) : null;

  const countdown = countdownWords(ask, Date.now());

  const choices = (
    <div className="ask-card__choices">
      <div className="ask-card__buttons" role="group" aria-label="Your answer">
        {p.choices.map((choice) => (
          <Button
            key={choice.id}
            size="sm"
            variant={choice === primary ? 'primary' : 'secondary'}
            disabled={busy || !answerable || (choice.id === 'apply-selected' && selected.size === 0) || (p.kind === 'answer-command-prompt' && choice.id === 'once' && execAnswer.length === 0)}
            onClick={() => run(choice)}
          >
            {choiceLabel(choice, question)}
          </Button>
        ))}
      </div>
      {!p.remember.offered && record && cannotUndo && <span className="ask-card__note">{capitalized(p.remember.why)}</span>}
    </div>
  );

  const rememberStep = mode.step === 'remember' && p.remember.offered ? (
    <div className="ask-card__step" role="group" aria-label="Don't ask again for">
      <div className="ask-card__tiers">
        {p.remember.tiers.map((tier) => (
          <Radio key={tier.tier} name={`remember-${ask.key}`} checked={rememberTier === tier.tier} onChange={() => setRememberTier(tier.tier)}>
            <span className="ask-card__tier">{tier.label}</span>
            {tier.detail && <span className="ask-card__tier-detail">{tier.detail}</span>}
          </Radio>
        ))}
      </div>
      <div className="ask-card__buttons">
        <Button size="sm" variant="primary" disabled={busy || !rememberTier} onClick={() => run(p.choices.find((c) => c.id === 'remember')!, { rememberTier })}>Allow and remember</Button>
        <Button size="sm" variant="ghost" onClick={() => setMode({ step: 'choose' })}>Back</Button>
      </div>
    </div>
  ) : null;

  const textStep = mode.step === 'refuse' || mode.step === 'own-words' ? (
    <form
      className="ask-card__step"
      onSubmit={(event) => {
        event.preventDefault();
        if (mode.step === 'own-words' && !text.trim()) return;
        run(mode.choice, { text });
        setText('');
      }}
    >
      <Input
        autoFocus
        aria-label={mode.step === 'refuse' ? 'Why not (optional)' : 'Your answer'}
        placeholder={mode.step === 'refuse' ? 'Why not? (optional)' : 'Your answer'}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="ask-card__buttons">
        <Button size="sm" type="submit" variant="primary" disabled={busy || (mode.step === 'own-words' && !text.trim())}>
          {mode.step === 'refuse' ? 'Refuse' : 'Send'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setMode({ step: 'choose' }); setText(''); }}>Back</Button>
      </div>
    </form>
  ) : null;

  const details = [...p.details, ...extraDetails];

  return (
    <div
      id={`ask-${ask.key}`}
      className={`ask-card ask-card--${variant}${cannotUndo ? ' ask-card--undo' : ''}${question ? ' ask-card--question' : ''}`}
      role="group"
      aria-label={p.question}
    >
      {lead}
      <p className="ask-card__question">{p.question}</p>
      {p.body && <p className="ask-card__body">{p.body}</p>}
      {subject}
      {execPrompt?.recentOutput && (
        <pre className="ask-card__output" aria-label="What the command printed last">{execPrompt.recentOutput}</pre>
      )}
      {consequence}
      {countdown && <p className="ask-card__dim">{capitalized(countdown)}.</p>}
      {answerable && hunks && hunks.length > 0 && p.choices.some((choice) => choice.id === 'apply-selected') && (
        <ul className="ask-card__hunks" aria-label="Changes to apply">
          {hunks.map((hunk, index) => (
            <li key={hunk.id ?? index}>
              <Checkbox
                checked={selected.has(index)}
                onChange={() => setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index); else next.add(index);
                  return next;
                })}
              >
                <span className="ask-card__hunk">{hunkSummary(hunk)}</span>
              </Checkbox>
            </li>
          ))}
        </ul>
      )}
      {answerable && p.kind === 'answer-command-prompt' && (
        <Input
          aria-label="The reply the command is waiting for"
          placeholder="Type the reply the command is waiting for"
          value={execAnswer}
          disabled={busy}
          onChange={(event) => setExecAnswer(event.target.value)}
        />
      )}
      {answerable && (mode.step === 'choose' ? choices : rememberStep ?? textStep)}
      {refused && <p className="ask-card__dim">{refused}</p>}
      <p className="ask-card__links">
        {p.why && (
          <button type="button" className="ask-card__link" aria-expanded={open === 'why'} onClick={() => setOpen(open === 'why' ? null : 'why')}>Why am I asked?</button>
        )}
        {p.why && details.length > 0 && <span aria-hidden="true"> · </span>}
        {details.length > 0 && (
          <button type="button" className="ask-card__link" aria-expanded={open === 'details'} onClick={() => setOpen(open === 'details' ? null : 'details')}>Details</button>
        )}
      </p>
      {open === 'why' && <p className="ask-card__why">{p.why}</p>}
      {open === 'details' && (
        <dl className="ask-card__details">
          {details.map((row, index) => (
            <div key={`${row.label}-${index}`} className="ask-card__detail">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The one dim line an ask leaves once decided: "You said yes once · 2:41 pm". */
export function DecidedLine({ decided }: { decided: DecidedWords }) {
  return <p className="ask-card-decided">{decided.words} · {clockWords(decided.at)}</p>;
}

/** "just now", "3 min ago": when an ask was raised. */
export function askedWhen(ask: OpenAsk, now: number): string {
  return agoWords(ask.askedAt, now);
}
