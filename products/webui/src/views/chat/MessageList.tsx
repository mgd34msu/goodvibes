import { RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDown, Square, X } from 'lucide-react';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { Spark } from '../../components/shell/Spark';
import { useReducedMotion } from '../../components/motion/useReducedMotion';
import { MessageItem } from './MessageItem';
import { runningCallSummary, ToolCallLine } from './ToolActivityGroup';
import { lineageNodeKey, type LineageNode } from './lineage';
import { bestId, canResendUserMessage, messageTone } from './message-utils';
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
}: MessageListProps) {
  const reducedMotion = useReducedMotion();
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
          {nodes.map((node, index) => (
            <MessageItem
              key={lineageNodeKey(node, index)}
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
          ))}
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
                        >
                          <Square size={10} aria-hidden="true" />
                          Stop
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
