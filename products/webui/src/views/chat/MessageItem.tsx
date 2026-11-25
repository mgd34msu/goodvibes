import { Check, Clock, Copy, Layers, MoreHorizontal, Paperclip, Pencil, RotateCcw, X } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';
import type { ChatMessage } from './types';
import type { BranchChoice, SupersededReason } from './lineage';
import { BranchSwitcher, MessageLineage, messageIsEdited } from './MessageLineage';
import { useArtifactsPanel } from './ArtifactsPanel';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { SpeakButton, SpeakMenuItem } from '../../components/voice/SpeakButton';
import { Menu, MenuItem } from '../../components/ui/Menu';
import { PHONE_QUERY, useMediaQuery } from '../../components/ui/overlay';
import { MemoryProvenanceChip } from './MemoryProvenanceChip';
import { ToolActivityGroup } from './ToolActivityGroup';
import { failureReadingOf, TurnFailureRow } from './TurnFailureRow';
import { readMemoryProvenanceIds } from '../../lib/memory-provenance';
import { useWebUiPreferences } from '../../lib/ui-preferences';
import { formatShortcut } from '../../lib/shortcut-keys';
import { isCompactionHandoffMessage } from '../../lib/compaction';
import {
  attachmentLabel,
  attachmentMeta,
  deliveryState,
  messageAttachments,
  removedAttachmentNames,
  storedAttachmentId,
  messageText,
  messageTone,
  messageTimeMs,
  messageTimestamp,
  messageTimestampTitle,
  bestId,
} from './message-utils';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Spark } from '../../components/shell/Spark';
import '../../styles/components/chat-actions.css';

interface MessageItemProps {
  message: ChatMessage;
  index: number;
  isSendPending: boolean;
  copiedMessageId: string;
  /** Superseded messages retained behind this message's fork, oldest first. */
  priorMessages?: readonly ChatMessage[];
  /** Why the retained run was superseded ('regenerate' | 'edit'). */
  reason?: SupersededReason;
  /** The original message id when this message replaced an edited one. */
  revisionOf?: string;
  /** True when this message is the current search jump-to-message target, flashes a brief highlight. */
  isHighlighted?: boolean;
  /** Whether Resend is offered on a user message; defaults to "it has text". */
  canResend?: boolean;
  onCopyMessage: (message: ChatMessage) => void;
  onResendMessage: (message: ChatMessage) => void;
  onRegenerateFrom: (messageId: string) => void;
  /** Called when the user submits an edited version of a user message; resolves true once it was accepted. */
  onEditMessage?: (message: ChatMessage, newText: string) => Promise<boolean>;
  /** This is the newest failed reply: its failure row keeps its next steps. */
  latestFailure?: boolean;
  /** "Use another model" on a failed reply: open the model menu, then try the same prompt with the model chosen. */
  onUseAnotherModel?: (messageId: string) => void;
  /** Remove a file from this sent message (the caller asks first: it cannot be put back). */
  onRemoveAttachment?: (message: ChatMessage, artifactId: string, name: string) => void;
  /** When this message's turn has other versions: which one this is, of how many. */
  branches?: BranchChoice;
  /** Put another version of this turn on the conversation (by its first message's id). */
  onSwitchBranch?: (messageId: string) => void;
  /** A reply is being written: versions cannot be switched until it ends. */
  isStreaming?: boolean;
}

/** Memoised: a keystroke in the composer or a streamed token re-renders a message only when its own props change. */
export const MessageItem = memo(function MessageItem({
  message,
  index,
  isSendPending,
  copiedMessageId,
  priorMessages,
  reason,
  revisionOf,
  isHighlighted = false,
  canResend,
  onCopyMessage,
  onResendMessage,
  onRegenerateFrom,
  onEditMessage,
  latestFailure = false,
  onUseAnotherModel,
  onRemoveAttachment,
  branches,
  onSwitchBranch,
  isStreaming = false,
}: MessageItemProps) {
  const id = bestId(message) || `${index}`;
  const tone = messageTone(message);
  const state = deliveryState(message);
  const text = messageText(message);
  const { openArtifacts } = useArtifactsPanel();
  // A reply that ended in an error or was refused: the partial it had (possibly none) and the failure row.
  const failedReply = tone === 'assistant' && state === 'failed';
  const failure = failedReply ? failureReadingOf(message, id) : null;
  const canRetry = (Boolean(text) && (tone === 'user' || tone === 'assistant')) || failedReply;
  // Never an epoch or "unknown" time: a missing or zero time shows nothing.
  const timestamp = messageTimestamp(message);
  const timestampTitle = messageTimestampTitle(message);
  const timeMs = messageTimeMs(message);
  const timeIso = timeMs === null ? undefined : new Date(timeMs).toISOString();
  const attachments = messageAttachments(message);
  const removedNames = removedAttachmentNames(message);
  // A file of a message the daemon has (not one still sending or never sent) can be removed.
  const canRemoveFiles = tone === 'user' && onRemoveAttachment !== undefined && state !== 'local' && state !== 'failed';
  const isEdited = messageIsEdited(reason, revisionOf);
  const [{ memoryProvenanceChipEnabled }] = useWebUiPreferences();
  const memoryProvenanceIds = readMemoryProvenanceIds(message.metadata);

  // ---------------------------------------------------------------------------
  // Inline edit state (user messages only)
  // ---------------------------------------------------------------------------
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleEditStart = useCallback(() => {
    setEditDraft(text);
    setIsEditing(true);
    // Focus textarea on next tick after render
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [text]);

  const handleEditCancel = useCallback(() => {
    setIsEditing(false);
    setEditDraft('');
  }, []);

  // The editor stays open with its text until the edit is accepted, so a refused
  // edit leaves the typed words in place under the error the chat shows.
  const [editSubmitting, setEditSubmitting] = useState(false);
  const handleEditSubmit = useCallback(() => {
    const trimmed = editDraft.trim();
    if (!trimmed || isSendPending || editSubmitting || !onEditMessage) return;
    setEditSubmitting(true);
    void onEditMessage(message, trimmed).then((accepted) => {
      setEditSubmitting(false);
      if (!accepted) return;
      setIsEditing(false);
      setEditDraft('');
    });
  }, [editDraft, editSubmitting, isSendPending, message, onEditMessage]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleEditSubmit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleEditCancel();
      }
    },
    [handleEditSubmit, handleEditCancel],
  );

  const isAssistant = tone === 'assistant';
  const toolActivity = isAssistant && message.toolActivity && message.toolActivity.length > 0 ? message.toolActivity : null;
  // Quiet in the hover row; states that need attention (not sent, pending,
  // stopped, queued) stay visible without hovering.
  const persistentState = state !== '' && state !== 'sent' && !failedReply;
  const phone = useMediaQuery(PHONE_QUERY);
  const showEdit = tone === 'user' && canRetry && !isEditing && onEditMessage !== undefined;
  const showRetry = (isAssistant ? canRetry : (canResend ?? canRetry)) && !isEditing;
  const showArtifacts = isAssistant && (Boolean(text) || attachments.length > 0);

  const content = isEditing && tone === 'user' ? (
    <div className="message-edit-area">
      <textarea
        ref={textareaRef}
        className="message-edit-textarea"
        value={editDraft}
        onChange={(e) => setEditDraft(e.target.value)}
        onKeyDown={handleEditKeyDown}
        aria-label="Edit message"
        rows={3}
      />
      <div className="message-edit-actions">
        <Button variant="ghost" size="sm" className="message-edit-cancel" onClick={handleEditCancel} aria-label="Cancel edit">
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="message-edit-submit"
          onClick={handleEditSubmit}
          disabled={!editDraft.trim() || isSendPending || editSubmitting}
          aria-label={`Send edited message (${formatShortcut('mod+enter')})`}
        >
          Send
        </Button>
      </div>
    </div>
  ) : (
    <div className="message-bubble">
      {text && tone === 'user' && isCompactionHandoffMessage(text) ? (
        // Compactor-authored continuation, not typed input: folded by
        // default so the re-injected instruction wall doesn't repeat in
        // the transcript after every automatic compaction.
        <details className="message-compaction-handoff">
          <summary>Compaction handoff: context re-injected after auto-compaction ({text.split('\n').length} lines)</summary>
          <MarkdownMessage content={text} />
        </details>
      ) : (
        text && <MarkdownMessage content={text} />
      )}
      {(attachments.length > 0 || removedNames.length > 0) && (
        <div className="message-attachments">
          {attachments.map((attachment, attachmentIndex) => {
            const label = attachmentLabel(attachment);
            const storedId = canRemoveFiles ? storedAttachmentId(attachment) : '';
            return (
              <div key={`${id}-attachment-${attachmentIndex}`} className="message-attachment">
                <Paperclip size={14} aria-hidden="true" />
                <div>
                  <strong>{label}</strong>
                  {attachmentMeta(attachment) && <span>{attachmentMeta(attachment)}</span>}
                </div>
                {storedId && (
                  <IconButton
                    size="sm"
                    label={`Remove ${label}`}
                    icon={<X />}
                    tooltipPlacement="top"
                    className="message-attachment__remove"
                    onClick={() => onRemoveAttachment?.(message, storedId, label)}
                  />
                )}
              </div>
            );
          })}
          {removedNames.map((name, removedIndex) => (
            <p key={`${id}-removed-${removedIndex}`} className="message-attachment message-attachment--removed">
              <Paperclip size={14} aria-hidden="true" />
              <span>{name} was removed</span>
            </p>
          ))}
        </div>
      )}
      {failure && (
        <TurnFailureRow
          reading={failure}
          latest={latestFailure}
          onRetry={() => onRegenerateFrom(id)}
          onOtherModel={() => onUseAnotherModel?.(id)}
        />
      )}
      {/* A turn that only ran tools says what it did in the tool fold above. */}
      {!text && attachments.length === 0 && removedNames.length === 0 && !failedReply && !(message.toolActivity && message.toolActivity.length > 0) && (
        <p className="message-empty">{isAssistant ? 'This reply has no text.' : 'This message has no text.'}</p>
      )}
    </div>
  );

  const footer = (
    <div className={`message-actions${persistentState ? ' message-actions--state' : ''}`}>
      <div className="message-actions-inner">
        {/* Delivery indicator (a failed reply says so in its failure row) */}
        {state && !failedReply && (
          <span
            className={`delivery-indicator ${state}`}
            title={
              state === 'failed' ? 'Not sent'
                : state === 'local' ? 'Pending'
                  : state === 'cancelled' ? 'Stopped before completion: this is the partial reply that existed when the turn was stopped'
                    : state === 'queued' ? 'Queued: will run after the current reply finishes'
                      : state === 'unanswered' ? 'Not answered: this chat closed or the daemon restarted before this queued message ran. Send it again to get a reply'
                        : 'Sent'
            }
          >
            {state === 'failed' ? <><X size={12} aria-hidden="true" /> Not sent</>
              : state === 'cancelled' ? <><X size={12} aria-hidden="true" /> Stopped</>
                : state === 'queued' ? <><Clock size={12} aria-hidden="true" /> Queued</>
                  : state === 'unanswered' ? <><X size={12} aria-hidden="true" /> Not answered</>
                    : state === 'local' ? <><Clock size={12} aria-hidden="true" /> Sending</>
                      : <Check size={12} aria-label="Sent" />}
          </span>
        )}

        {(timestamp || isEdited) && (
          <span className="message-meta">
            {timestamp && <time dateTime={timeIso} title={timestampTitle}>{timestamp}</time>}
            {isEdited && <span className="message-meta__edited">{timestamp ? ' · ' : ''}Edited</span>}
          </span>
        )}

        {phone ? (
          // On a phone: Copy with its word, and the rest by name under More.
          <span className="message-actions__buttons message-actions__buttons--phone">
            <Button
              variant="ghost"
              size="sm"
              icon={copiedMessageId === id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              onClick={() => onCopyMessage(message)}
            >
              {copiedMessageId === id ? 'Copied' : 'Copy'}
            </Button>
            {(showEdit || showRetry || (isAssistant && Boolean(text)) || showArtifacts) && (
              <Menu
                label="More for this message"
                trigger={(props) => (
                  <Button {...props} variant="ghost" size="sm" icon={<MoreHorizontal aria-hidden="true" />}>More</Button>
                )}
              >
                {showEdit && <MenuItem icon={<Pencil aria-hidden="true" />} disabled={isSendPending} onSelect={handleEditStart}>Edit and resend</MenuItem>}
                {showRetry && (
                  <MenuItem
                    icon={<RotateCcw aria-hidden="true" />}
                    disabled={isSendPending}
                    onSelect={() => (isAssistant ? onRegenerateFrom(id) : onResendMessage(message))}
                  >
                    {isAssistant ? 'Regenerate response' : 'Resend message'}
                  </MenuItem>
                )}
                {isAssistant && text && <SpeakMenuItem messageId={message.id ?? id} sessionId={message.sessionId} contentRevision={message.contentRevision} text={text} />}
                {showArtifacts && <MenuItem icon={<Layers aria-hidden="true" />} onSelect={() => openArtifacts(message)}>Code and files in this reply</MenuItem>}
              </Menu>
            )}
          </span>
        ) : (
        <span className="message-actions__buttons">
          <IconButton
            size="sm"
            label="Copy message"
            icon={copiedMessageId === id ? <Check /> : <Copy />}
            tooltipPlacement="top"
            onClick={() => onCopyMessage(message)}
          />

          {/* Edit and branch (user messages only): the edited text becomes a new
              branch; the original stays as retained history. */}
          {showEdit && (
            <IconButton
              size="sm"
              label="Edit and resend message"
              icon={<Pencil />}
              tooltipPlacement="top"
              disabled={isSendPending}
              onClick={handleEditStart}
            />
          )}

          {/* Resend / Regenerate */}
          {showRetry && (
            <IconButton
              size="sm"
              label={isAssistant ? 'Regenerate response' : 'Resend message'}
              icon={<RotateCcw />}
              tooltipPlacement="top"
              disabled={isSendPending}
              onClick={() => (isAssistant ? onRegenerateFrom(id) : onResendMessage(message))}
            />
          )}

          {/* Read aloud. Spoken output for assistant replies (honest states inside) */}
          {isAssistant && text && <SpeakButton messageId={message.id ?? id} sessionId={message.sessionId} contentRevision={message.contentRevision} text={text} />}

          {/* Artifacts: opens the side panel with this reply's code blocks and files */}
          {showArtifacts && (
            <IconButton
              size="sm"
              label="View artifacts from this message"
              icon={<Layers />}
              tooltipPlacement="top"
              className="message-action-artifacts"
              onClick={() => openArtifacts(message)}
            />
          )}
        </span>
        )}

        {/* Copied label, announced (the phone's Copy button says it in its own word) */}
        {copiedMessageId === id && !phone && <span className="message-action-label" role="status">Copied</span>}
        {copiedMessageId === id && phone && <span className="gv-sr-only" role="status">Copied</span>}
      </div>
    </div>
  );

  return (
    <article
      className={`message ${tone}${isHighlighted ? ' message--search-highlight' : ''}`}
      data-message-id={id}
    >
      {isAssistant && <span className="message-mark" aria-hidden="true"><Spark size={18} /></span>}
      <div className="message-body">
        {/* Honest-lineage disclosure: when this message heads a fork, reveal the retained
            (superseded) history rather than pretending it is gone. */}
        {/* A turn with versions has its switcher instead of the "Edited" mark here. */}
        <MessageLineage priorMessages={priorMessages} reason={reason} revisionOf={branches ? undefined : revisionOf} />
        {toolActivity && <ToolActivityGroup toolActivity={toolActivity} />}
        {content}
        {branches && onSwitchBranch && !isEditing && (
          <BranchSwitcher choice={branches} disabled={isSendPending || isStreaming} onSwitch={onSwitchBranch} />
        )}
        {footer}
        {/* Memory provenance. Owner-ruled, default OFF (see ui-preferences.ts). Renders
            nothing when the preference is off or this turn used no memories. */}
        {isAssistant && memoryProvenanceChipEnabled && memoryProvenanceIds.length > 0 && (
          <MemoryProvenanceChip recordIds={memoryProvenanceIds} />
        )}
      </div>
    </article>
  );
});
