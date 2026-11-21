/**
 * The asks a chat is waiting on, in that chat (ux A2.4): each one a card below
 * the last message, in the message column, with its choices (AskCard), and the
 * header chip `asking you · 1` that lists them and scrolls to one. Work lists
 * the same asks too.
 *
 * An ask belongs to the chat whose session raised it. Once it is decided the
 * card folds to one dim line ("You said yes once · 2:41 pm", or what the
 * approval's reading says when it was decided somewhere else) for as long as
 * the chat stays open.
 *
 * Reads the asks the app already holds (useOpenAsks: `approvals.list` and one
 * `inbox.list`, both revalidated by their stream frames), so opening a chat
 * adds no request.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOpenAsks } from '../../hooks/useOpenAsks';
import { approvalReading, type ApprovalReading } from '../../lib/approvals';
import { readingStateLine, type OpenAsk } from '../../lib/asks';
import type { ApprovalRecord } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { Menu, MenuItem, MenuMeta, MenuSeparator } from '../../components/ui/Menu';
import { ModeSheetItems } from '../../components/shell/ModeChip';
import { useOptionalShell } from '../../components/shell/ShellContext';
import { AskCard, DecidedLine, type DecidedWords } from '../work/AskCard';
import { useApprovalActions } from '../work/useApprovalActions';
import { useAskActions } from '../work/useAskActions';
import '../../styles/components/ask-card.css';

/** The open asks raised by this chat's session, oldest first (the order they were asked in). */
export function useChatAsks(sessionId: string): OpenAsk[] {
  const { asks } = useOpenAsks(Boolean(sessionId));
  return useMemo(
    () => asks.filter((ask) => ask.sessionId === sessionId).sort((a, b) => a.askedAt - b.askedAt),
    [asks, sessionId],
  );
}

function scrollToAsk(key: string): void {
  const element = document.getElementById(`ask-${key}`);
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
}

/**
 * The header chip: `asking you · 1`, opening this chat's asks; choosing one
 * scrolls to its card. On a phone header the mode chip steps aside for the
 * chat's title while this chip shows (shell.css), so its sheet ends with the
 * mode in force and `Change`.
 */
export function ChatAsksChip({ sessionId, onOpenSettings }: { sessionId: string; onOpenSettings?: ((section: string) => void) | undefined }) {
  const asks = useChatAsks(sessionId);
  const phoneHeader = useOptionalShell()?.mode === 'drawer';
  if (asks.length === 0) return null;
  return (
    <Menu
      label="What this chat is asking you"
      placement="bottom-end"
      width={300}
      trigger={(props) => (
        <button type="button" {...props} className="chat-asks-chip" aria-label={`Asking you: ${asks.length}`}>
          asking you · {asks.length}
        </button>
      )}
    >
      <MenuMeta>Waiting for your answer in this chat</MenuMeta>
      {asks.map((ask) => (
        <MenuItem key={ask.key} wrap onSelect={() => window.requestAnimationFrame(() => scrollToAsk(ask.key))}>
          {ask.presentation.title}
        </MenuItem>
      ))}
      {phoneHeader && <MenuSeparator />}
      {phoneHeader && <ModeSheetItems onOpenSettings={onOpenSettings} withLabel />}
    </Menu>
  );
}

/** What an approval that left the open list without a choice made here says now. */
function decidedElsewhere(record: ApprovalRecord | undefined): DecidedWords | undefined {
  if (!record) return undefined;
  const reading: ApprovalReading = approvalReading(record);
  if (reading.phase === 'waiting') return undefined;
  return { words: readingStateLine(reading), at: reading.decision?.at ?? record.updatedAt };
}

/** The cards, below the last message. Renders nothing when the chat waits on nothing. */
export function InlineAsks({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const asks = useChatAsks(sessionId);
  const approvalActions = useApprovalActions({ pushHandoff: false });
  const askActions = useAskActions(approvalActions);
  const [decided, setDecided] = useState<ReadonlyMap<string, DecidedWords>>(() => new Map());
  const seen = useRef(new Map<string, OpenAsk>());

  // An ask this chat showed that is no longer open folds to its line: the words of the
  // choice made here, or, for an approval decided somewhere else, what its reading says.
  const openKeys = useMemo(() => new Set(asks.map((ask) => ask.key)), [asks]);
  useEffect(() => {
    const gone = [...seen.current.values()].filter((ask) => !openKeys.has(ask.key));
    for (const ask of asks) seen.current.set(ask.key, ask);
    if (gone.length === 0) return;
    const list = queryClient.getQueryData<{ approvals?: readonly ApprovalRecord[] }>(queryKeys.approvals)?.approvals ?? [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- folds asks that left the list this render
    setDecided((current) => {
      const next = new Map(current);
      for (const ask of gone) {
        seen.current.delete(ask.key);
        if (next.has(ask.key)) continue;
        const words = ask.approval ? decidedElsewhere(list.find((record) => record.id === ask.id)) : { words: 'Answered', at: Date.now() };
        if (words) next.set(ask.key, words);
      }
      return next;
    });
  }, [asks, openKeys, queryClient]);

  const folded = [...decided.entries()].filter(([key]) => !openKeys.has(key));
  if (asks.length === 0 && folded.length === 0) return null;
  return (
    <div className="chat-asks" role="region" aria-label="Waiting for your answer">
      {folded.map(([key, words]) => <DecidedLine key={key} decided={words} />)}
      {asks.map((ask) => (
        <AskCard
          key={`${ask.key}:${ask.approval?.revision ?? 0}`}
          ask={ask}
          actions={askActions}
          variant="inline"
          onDecided={(answered, words) => setDecided((current) => new Map(current).set(answered.key, words))}
        />
      ))}
    </div>
  );
}
