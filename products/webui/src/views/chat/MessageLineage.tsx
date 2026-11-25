import { ChevronDown, ChevronLeft, ChevronRight, History, Paperclip } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ChatMessage } from './types';
import type { BranchChoice, SupersededReason } from './lineage';
import { IconButton } from '../../components/ui/IconButton';
import { retainedHistoryLabel, sortByCreatedAt, supersededReason as reasonOf } from './lineage';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { attachmentLabel, bestId, messageAttachments, messageText, messageTone } from './message-utils';

interface MessageLineageProps {
  /** Superseded messages retained behind this message's fork, oldest first. */
  priorMessages?: readonly ChatMessage[];
  /** Why the retained run was superseded ('regenerate' | 'edit'). */
  reason?: SupersededReason;
  /** Present when this message replaced an edited one (labels it "Edited" even with no run). */
  revisionOf?: string;
}

/**
 * A retained (superseded) message, rendered read-only and muted. This is the honest
 * lineage surface: history behind a regenerate or an edit is never hidden, only folded
 * away by default and revealed on demand, it is still on the server and still shown.
 */
function RetainedMessage({ message }: { message: ChatMessage }) {
  const tone = messageTone(message);
  const text = messageText(message);
  const attachments = messageAttachments(message);
  return (
    <article className={`retained-message ${tone}`} aria-label={`Retained ${tone} message`}>
      <span className="retained-message__role">{tone === 'user' ? 'You' : 'Assistant'}</span>
      <div className="retained-message__body">
        {text ? <MarkdownMessage content={text} /> : null}
        {attachments.length > 0 && (
          <div className="retained-message__attachments">
            {attachments.map((attachment, attachmentIndex) => (
              <span key={`retained-attachment-${attachmentIndex}`} className="retained-message__attachment">
                <Paperclip size={11} /> {attachmentLabel(attachment)}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * The honest-lineage disclosure for a message that heads a regenerate/edit fork. Owns its
 * own collapsed/expanded state so the enclosing MessageItem stays free of the render-time
 * state coupling that the retained history introduces. Renders nothing when there is no
 * retained history and the message is not an edit replacement.
 */
export function MessageLineage({ priorMessages, reason, revisionOf }: MessageLineageProps) {
  const [showRetained, setShowRetained] = useState(false);
  const toggleRetained = useCallback(() => setShowRetained((current) => !current), []);

  const retained = priorMessages ? sortByCreatedAt(priorMessages) : [];
  const hasRetained = retained.length > 0;
  const retainedReason: SupersededReason | undefined = hasRetained
    ? (reason ?? reasonOf(retained[0]))
    : (revisionOf ? 'edit' : undefined);
  const isEdited = Boolean(revisionOf) || retainedReason === 'edit';

  if (!hasRetained && !isEdited) return null;

  return (
    <div className="message-lineage">
      <button
        type="button"
        className="message-lineage__toggle"
        aria-expanded={showRetained}
        disabled={!hasRetained}
        onClick={toggleRetained}
        title={hasRetained ? 'Show or hide retained history' : 'Edited message'}
      >
        {hasRetained
          ? (showRetained ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
          : <History size={12} />}
        <span>{hasRetained ? retainedHistoryLabel(retainedReason, retained.length) : 'Edited'}</span>
      </button>
      {showRetained && hasRetained && (
        <div className="message-lineage__retained" role="group" aria-label="Retained history">
          <p className="message-lineage__note">
            Kept as history: the daemon retains superseded messages, they are never deleted.
          </p>
          {retained.map((retainedMessage, retainedIndex) => (
            <RetainedMessage
              key={`${bestId(retainedMessage) || 'retained'}-${retainedIndex}`}
              message={retainedMessage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The switcher on a turn that has versions (an edited message, or a regenerated
 * reply): which version of how many, and the one before and after. Switching puts
 * that version on the conversation in the daemon, so it is the one shown on every
 * device and after leaving the chat and coming back, and the one the model continues.
 */
export function BranchSwitcher({ choice, disabled = false, onSwitch }: {
  choice: BranchChoice;
  disabled?: boolean;
  onSwitch: (messageId: string) => void;
}) {
  const { previousId, nextId } = choice;
  return (
    <div className="message-branches" role="group" aria-label={`Version ${String(choice.position)} of ${String(choice.count)}`}>
      <IconButton
        size="sm"
        label="Previous version"
        icon={<ChevronLeft />}
        tooltipPlacement="top"
        disabled={disabled || !previousId}
        onClick={() => { if (previousId) onSwitch(previousId); }}
      />
      <span className="message-branches__place">{choice.position} of {choice.count}</span>
      <IconButton
        size="sm"
        label="Next version"
        icon={<ChevronRight />}
        tooltipPlacement="top"
        disabled={disabled || !nextId}
        onClick={() => { if (nextId) onSwitch(nextId); }}
      />
    </div>
  );
}

/** True when a message heads an edit fork (used for the "· edited" meta label). */
export function messageIsEdited(reason: SupersededReason | undefined, revisionOf: string | undefined): boolean {
  return Boolean(revisionOf) || reason === 'edit';
}
