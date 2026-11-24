import { RefObject, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDown, Square, X } from 'lucide-react';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { Spark } from '../../components/shell/Spark';
import { useReducedMotion } from '../../components/motion/useReducedMotion';
import { motionReduced } from '../../lib/ui-preferences';
import { MessageItem } from './MessageItem';
import { runningCallSummary, ToolCallLine } from './ToolActivityGroup';
import { lineageNodeKey, type LineageNode } from './lineage';
import { bestId, canResendUserMessage, messageText, messageTone } from './message-utils';
import {
  ALWAYS_MOUNTED_TAIL,
  estimatedRowHeight,
  FIRST_DRAW_TAIL,
  firstVisibleRow,
  NATIVE_SCROLL_ANCHORING,
  NEAR_MARGIN_PX,
  rowElement,
  type RowAnchor,
} from './transcript-window';
import type { LiveReplyStore } from './live-reply-store';
import type { ChatMessage } from './types';
import type { ActiveToolCall } from './useChatStream';
import '../../styles/components/chat-stream.css';

interface MessageListProps {
  /** Honest-lineage render nodes: active messages with any retained history attached. */
  nodes: LineageNode[];
  /** The reply being streamed; only the live bubble subscribes to it. */
  liveReply: LiveReplyStore;
  /** Whether the live reply has any text yet. */
  hasLiveText: boolean;
  showJumpToBottom: boolean;
  isSendPending: boolean;
  /** Whether a turn is actively streaming (running | streaming | tooling). */
  isStreaming?: boolean;
  copiedMessageId: string;
  /** Id of the message to flash-highlight (search jump-to-message target), or '' for none. */
  highlightedMessageId?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Whether the files of a failed send are still held (so Resend can include them). */
  hasHeldFiles?: (messageId: string) => boolean;
  onScroll: () => void;
  onJumpToBottom: () => void;
  onCopyMessage: (message: ChatMessage) => void;
  onResendMessage: (message: ChatMessage) => void;
  onRegenerateFrom: (messageId: string) => void;
  /** Called when the user submits an edited version of a user message; resolves true once it was accepted. */
  onEditMessage?: (messageId: string, newText: string) => Promise<boolean>;
  /** Called when the user clicks the Stop button during an active stream. */
  onStop?: () => void;
  /** Tool calls currently running for the active turn (useChatStream's ActiveToolCall). */
  activeToolCalls?: readonly ActiveToolCall[];
  /** Cancel ONE running tool call, the turn itself continues (unlike onStop, which ends it). */
  onCancelToolCall?: (callId: string) => void;
  /**
   * What the working line under the last message says ("Thinking…", "Reading
   * 2 files…"); see workingStatusLabel. Empty falls back to "Thinking…".
   */
  workingLabel?: string;
  /** Rendered before the first message (the new-chat greeting). */
  lead?: ReactNode;
  /** Rendered below the last message and the live reply (the asks this chat waits on). */
  trailing?: ReactNode;
  /** "Use another model" on the newest failed reply. */
  onUseAnotherModel?: (messageId: string) => void;
  /** Scroll to this message (mounted first if it is not); a new `seq` asks again for the same one. */
  jumpRequest?: { readonly messageId: string; readonly seq: number } | null;
  /** Called once the jump-to message is on screen. */
  onJumped?: (messageId: string) => void;
}

/** One message's place in the transcript: the message when it is near the screen, else its plain text at its height. */
function TranscriptRow({ rowKey, mounted, height, text, observe, children }: {
  rowKey: string;
  mounted: boolean;
  height: number;
  text: string;
  observe: (element: HTMLDivElement | null) => (() => void) | undefined;
  children: () => ReactNode;
}) {
  return (
    <div
      ref={observe}
      className={mounted ? 'chat-row' : 'chat-row chat-row--text'}
      data-row-key={rowKey}
      style={mounted ? undefined : { height }}
    >
      {mounted ? children() : <p className="chat-row__text">{text}</p>}
    </div>
  );
}

/** The streamed reply's text: re-renders on its own, at most once per frame, as the text grows. */
function LiveReplyBubble({ store, showCaret, reducedMotion }: { store: LiveReplyStore; showCaret: boolean; reducedMotion: boolean }) {
  const text = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!text) return null;
  return (
    <div className="message-bubble">
      <MarkdownMessage content={text} live />
      {showCaret && (
        <span
          className={`stream-caret${reducedMotion ? ' stream-caret--reduced' : ''}`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function MessageList({
  nodes,
  liveReply,
  hasLiveText,
  showJumpToBottom,
  isSendPending,
  isStreaming = false,
  copiedMessageId,
  highlightedMessageId = '',
  scrollRef,
  hasHeldFiles = () => false,
  onScroll,
  onJumpToBottom,
  onCopyMessage,
  onResendMessage,
  onRegenerateFrom,
  onEditMessage,
  onStop,
  activeToolCalls = [],
  onCancelToolCall,
  workingLabel = '',
  lead,
  trailing,
  onUseAnotherModel,
  jumpRequest = null,
  onJumped,
}: MessageListProps) {
  const reducedMotion = useReducedMotion();
  const window_ = useTranscriptWindow(nodes, scrollRef, jumpRequest, onJumped);
  // What the status region says: "GoodVibes is replying…" while a turn runs, "GoodVibes replied." once it ends.
  const [replyAnnouncement, setReplyAnnouncement] = useState('');
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (isStreaming === wasStreaming.current) return;
    wasStreaming.current = isStreaming;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the turn's own start and end
    setReplyAnnouncement(isStreaming ? 'GoodVibes is replying…' : 'GoodVibes replied.');
  }, [isStreaming]);
  // Stop must be reachable for the WHOLE active turn, including the
  // pre-first-token window (model thinking, long tool calls), where there is
  // no liveText yet. Requiring text here used to make a turn unstoppable
  // until it started talking.
  const showStreamControls = isStreaming;
  // One callback for every user message, so the memo on MessageItem holds across
  // keystrokes and tokens; replies get none (they are not edited).
  const editMessage = useCallback(
    (message: ChatMessage, newText: string): Promise<boolean> =>
      onEditMessage ? onEditMessage(message.id ?? message.messageId ?? '', newText) : Promise.resolve(false),
    [onEditMessage],
  );

  // Only the newest reply's failure row keeps its next steps: a newer turn takes them away.
  let lastReply = -1;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (messageTone(nodes[index].message) === 'assistant') { lastReply = index; break; }
  }

  return (
    <div className="chat-thread">
      <div className="messages chat-conversation" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {lead}
          {nodes.map((node, index) => {
            const key = lineageNodeKey(node, index);
            const mounted = window_.isMounted(key, index, highlightedMessageId);
            return (
              <TranscriptRow
                key={key}
                rowKey={key}
                mounted={mounted}
                height={mounted ? 0 : window_.heightOf(key, node)}
                text={mounted ? '' : messageText(node.message)}
                observe={window_.observe}
              >
                {() => (
                  <MessageItem
                    message={node.message}
                    index={index}
                    isSendPending={isSendPending}
                    copiedMessageId={copiedMessageId}
                    priorMessages={node.priorMessages}
                    reason={node.reason}
                    revisionOf={node.revisionOf}
                    isHighlighted={highlightedMessageId !== '' && bestId(node.message) === highlightedMessageId}
                    canResend={canResendUserMessage(node.message, hasHeldFiles(bestId(node.message)))}
                    onCopyMessage={onCopyMessage}
                    onResendMessage={onResendMessage}
                    onRegenerateFrom={onRegenerateFrom}
                    onEditMessage={onEditMessage && messageTone(node.message) === 'user' ? editMessage : undefined}
                    latestFailure={index === lastReply && !isStreaming}
                    onUseAnotherModel={onUseAnotherModel}
                  />
                )}
              </TranscriptRow>
            );
          })}
          {/* A screen reader hears that a reply started and that it finished, not every token:
              a live region over the streaming text would read it out word by word. The finished
              reply is the newest message above, to read at the reader's own pace. */}
          <p className="gv-sr-only" role="status">{replyAnnouncement}</p>
          {(hasLiveText || isStreaming) && (
            <div>
              <article className="message assistant streaming">
                <span className="message-mark" aria-hidden="true"><Spark size={18} /></span>
                <div className="message-body">
                  <LiveReplyBubble store={liveReply} showCaret={showStreamControls} reducedMotion={reducedMotion} />
                  {showStreamControls && (
                    // One line naming what is happening right now; it shimmers (the
                    // only animated text in the product) and holds still with
                    // reduced motion. Stop sits at its end for the whole turn,
                    // including the window before the first token.
                    <div className="chat-working">
                      <span
                        className={`chat-working__label${reducedMotion ? ' chat-working__label--still' : ''}`}
                      >
                        {workingLabel || 'Thinking…'}
                      </span>
                      {onStop && (
                        <button
                          type="button"
                          className="stream-stop-btn"
                          onClick={onStop}
                          aria-label="Stop generating"
                          aria-keyshortcuts="Escape"
                          title="Stop generating (Esc)"
                        >
                          <Square size={10} aria-hidden="true" />
                          Stop
                          <kbd className="stream-stop-btn__key" aria-hidden="true">Esc</kbd>
                        </button>
                      )}
                    </div>
                  )}
                  {/* Running tool calls, one line each as the terminal draws them. Cancel ONE
                      call without ending the turn; a cancelled call reads "cancelled" until the
                      daemon's own turn.tool_result clears it. */}
                  {activeToolCalls.length > 0 && (
                    <ul className="tool-lines active-tool-calls" aria-label="Running tool calls">
                      {activeToolCalls.map((call) => (
                        <ToolCallLine
                          key={call.toolCallId}
                          summary={runningCallSummary(call)}
                          trailing={!call.cancelled && onCancelToolCall ? (
                            <button
                              type="button"
                              className="active-tool-call__cancel"
                              onClick={() => onCancelToolCall(call.toolCallId)}
                              aria-label={`Cancel ${runningCallSummary(call).name}`}
                            >
                              <X size={12} aria-hidden="true" /> Cancel
                            </button>
                          ) : undefined}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            </div>
          )}
          {trailing}
        </div>
      </div>
      {showJumpToBottom && (
        <button
          type="button"
          className="jump-to-bottom glass"
          onClick={onJumpToBottom}
          aria-label="Jump to latest message"
          title="Jump to latest message"
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** The transcript's window: which rows hold their message (see transcript-window.ts for what it keeps). */
function useTranscriptWindow(
  nodes: readonly LineageNode[],
  scrollRef: RefObject<HTMLDivElement | null>,
  jumpRequest: { readonly messageId: string; readonly seq: number } | null,
  onJumped: ((messageId: string) => void) | undefined,
) {
  // The rows the observer reports near the screen, and the set drawn from it (held while text is selected).
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  // Until the observer first reports, the newest rows are drawn: the chat opens at its end.
  const [observed, setObserved] = useState(false);
  const liveNear = useRef(new Set<string>());
  const heights = useRef(new Map<string, number>());
  const columnWidth = useRef(720);
  const rows = useRef(new Set<HTMLDivElement>());
  const intersection = useRef<IntersectionObserver | null>(null);
  const resize = useRef<ResizeObserver | null>(null);
  const anchor = useRef<(RowAnchor & { atBottom: boolean }) | null>(null);
  // The jumped-to message and where it stood once scrolled to, held until the person scrolls.
  const jumpHold = useRef<RowAnchor | null>(null);
  const selecting = useRef(false);

  // Where the first row on screen stands (a browser without scroll anchoring keeps it there by hand).
  const captureAnchor = useCallback(() => {
    const container = scrollRef.current;
    anchor.current = null;
    if (!container) return;
    const first = firstVisibleRow(container);
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 4;
    anchor.current = first ? { ...first, atBottom } : null;
  }, [scrollRef]);

  // Mounting is a transition: React draws the rows a few at a time between frames, so a scroll
  // through a long chat keeps its frame rate; a row still arriving shows its words meanwhile.
  const commitNear = useCallback(() => {
    captureAnchor();
    startTransition(() => setNear((current) => {
      const next = new Set(liveNear.current);
      const container = scrollRef.current;
      const active = typeof document === 'undefined' ? null : document.activeElement;
      for (const key of current) {
        if (next.has(key)) continue;
        // Nothing leaves while text is selected (both ends of the selection stay), nor a row holding the focus.
        if (selecting.current || (active && container && rowElement(container, key)?.contains(active))) next.add(key);
      }
      if (next.size === current.size && [...next].every((key) => current.has(key))) return current;
      return next;
    }));
  }, [captureAnchor, scrollRef]);

  const observe = useCallback((element: HTMLDivElement | null) => {
    if (!element) return undefined;
    rows.current.add(element);
    intersection.current?.observe(element);
    resize.current?.observe(element);
    return () => {
      rows.current.delete(element);
      intersection.current?.unobserve(element);
      resize.current?.unobserve(element);
      const key = element.dataset.rowKey;
      if (key) liveNear.current.delete(key);
    };
  }, []);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.rowKey;
        if (!key) continue;
        if (entry.isIntersecting) liveNear.current.add(key);
        else liveNear.current.delete(key);
      }
      setObserved(true);
      commitNear();
    }, { root: container, rootMargin: `${String(NEAR_MARGIN_PX)}px 0px` });
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = element.dataset.rowKey;
        if (!key || element.classList.contains('chat-row--text')) continue;
        const box = element.getBoundingClientRect();
        heights.current.set(key, box.height);
        if (box.width > 0) columnWidth.current = box.width;
      }
    });
    intersection.current = io;
    resize.current = ro;
    for (const row of rows.current) {
      io.observe(row);
      ro.observe(row);
    }
    return () => {
      io.disconnect();
      ro.disconnect();
      intersection.current = null;
      resize.current = null;
    };
  }, [scrollRef, commitNear]);

  // Rows above the screen changed what they hold. The jumped-to message keeps its place; otherwise the
  // browser's scroll anchoring keeps the rows on screen still, and where it has none the first row on
  // screen is put back by hand.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const held = anchor.current;
    anchor.current = null;
    if (!container) return;
    const hold = jumpHold.current;
    if (hold) {
      const target = rowElement(container, hold.key);
      if (!target) return;
      const shifted = target.getBoundingClientRect().top - container.getBoundingClientRect().top - hold.top;
      if (Math.abs(shifted) >= 1) container.scrollTop += shifted;
      return;
    }
    if (!held) return;
    // A view at the end stays at the end.
    if (held.atBottom) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    if (NATIVE_SCROLL_ANCHORING) return;
    const element = rowElement(container, held.key);
    if (!element) return;
    const moved = element.getBoundingClientRect().top - container.getBoundingClientRect().top - held.top;
    if (Math.abs(moved) >= 1) container.scrollTop += moved;
  }, [near, scrollRef]);

  // A selection holds every mounted row; once it is let go, the rows far from the screen leave again.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onSelectionChange = () => {
      const container = scrollRef.current;
      const selection = document.getSelection();
      const was = selecting.current;
      selecting.current = Boolean(container && selection && !selection.isCollapsed && selection.rangeCount > 0
        && (container.contains(selection.anchorNode) || container.contains(selection.focusNode)));
      if (was && !selecting.current) commitNear();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [commitNear, scrollRef]);

  // The person scrolling lets go of the jumped-to message's place. Where the first row on screen
  // stands (and whether the view is at the end) is kept as the person scrolls.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;
    // Any press, key or wheel anywhere (the jump-to-latest button, the composer) lets go of it.
    const release = () => { jumpHold.current = null; };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const name of events) document.addEventListener(name, release, { passive: true, capture: true });
    const onScroll = () => { if (!jumpHold.current) captureAnchor(); };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      for (const name of events) document.removeEventListener(name, release, { capture: true });
      container.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, captureAnchor]);

  // Jump: the target is mounted in this render (isMounted); scroll to it, then hold its place.
  const jumpSeq = jumpRequest?.seq;
  useLayoutEffect(() => {
    if (!jumpRequest) return;
    const container = scrollRef.current;
    const element = container ? rowElement(container, jumpRequest.messageId) : undefined;
    if (!container || !element) return;
    const edge = () => container.getBoundingClientRect().top;
    const distance = Math.abs(element.getBoundingClientRect().top - edge());
    // A short way glides (the rows on it are drawn already); a long way is one step, then held in place
    // while the rows around it are drawn.
    const smooth = !motionReduced() && distance < container.clientHeight * 1.5;
    element.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    jumpHold.current = smooth ? null : { key: jumpRequest.messageId, top: element.getBoundingClientRect().top - edge() };
    onJumped?.(jumpRequest.messageId);
    // A new request (its seq) asks again; the callback's identity does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq]);

  const count = nodes.length;
  const jumpTarget = jumpRequest?.messageId ?? '';
  const isMounted = useCallback((key: string, index: number, highlighted: string): boolean => {
    if (index >= count - (observed ? ALWAYS_MOUNTED_TAIL : FIRST_DRAW_TAIL)) return true;
    return near.has(key) || key === jumpTarget || (highlighted !== '' && key === highlighted);
  }, [count, observed, near, jumpTarget]);

  const heightOf = useCallback((key: string, node: LineageNode): number => (
    heights.current.get(key) ?? estimatedRowHeight(messageText(node.message), messageTone(node.message), columnWidth.current)
  ), []);

  return useMemo(() => ({ isMounted, heightOf, observe }), [isMounted, heightOf, observe]);
}
