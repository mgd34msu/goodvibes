import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { ArrowUp, Paperclip, Plus, X } from 'lucide-react';
import { formatError } from '../../lib/errors';
import { ModelPicker, type ModelPickerProps } from './ModelPicker';
import { dragHasFiles, filesFromDrop, imageFilesFromPaste, isImageFile, previewUrl } from './composer-attachments';
import { MicButton } from '../../components/voice/MicButton';
import { VoiceSettings } from '../../components/voice/VoiceSettings';
import '../../styles/components/chat-composer.css';
import '../../styles/components/voice.css';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A slash-command hint entry shown when the draft starts with "/". */
export interface SlashCommandHint {
  name: string;
  description: string;
}

export interface ComposerProps {
  /**
   * 'centered' on a new chat (the composer sits under the greeting), 'docked'
   * in a conversation (pinned to the bottom above the safe area).
   */
  layout?: 'centered' | 'docked';
  /** Visible placeholder; the accessible name stays "Message GoodVibes". */
  placeholder?: string;
  draft: string;
  attachedFiles: File[];
  isSendPending: boolean;
  sendError: unknown;
  turnError: string;
  renameSessionError: unknown;
  selectModelError: unknown;
  /** The model control: provider, then model, then effort, in one menu. */
  modelPicker: ModelPickerProps;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  /**
   * STEER: send immediately, interrupting the in-flight turn. Desktop:
   * Ctrl/Cmd+Enter (handled by the caller's key handler). Touch: press and
   * hold the send button. Omitted = the hold affordance is off.
   */
  onSteer?: () => void;
  /**
   * A reply is running in this chat: Send queues the message behind it, and a
   * second control sends now, interrupting it.
   */
  replyRunning?: boolean;
  /**
   * The draft was a `/command` this composer does not run: it was not sent, the
   * text stays in place, and the composer says so. `known` marks `/new` typed
   * with words after it.
   */
  heldCommand?: { word: string; known: boolean } | null;
  /** Send the held draft to the model as an ordinary message after all. */
  onSendHeldAsText?: () => void;
  onFileSelection: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachedFile: (index: number) => void;
  /**
   * Optional list of slash-command hints shown when the user types "/" at the
   * start of the composer. Defaults to empty, no menu.
   */
  slashCommands?: readonly SlashCommandHint[];
  /**
   * Optional callback invoked when files are added via drag-and-drop or
   * clipboard paste. When provided, DnD/paste routes files directly here
   * instead of synthesising a native input change event.
   *
   * Integration: wire this to the chat file handler so DnD/paste activate
   * at the ChatView level without needing a hidden-input workaround.
   *
   * The hidden-input native onChange (fileInputRef) is still used for
   * click-to-attach so ChatView compiles unchanged when this prop is absent.
   */
  onFilesAdded?: (files: File[]) => void;
}

// ─── Attachment chip ──────────────────────────────────────────────────────────

interface AttachmentChipProps {
  file: File;
  index: number;
  onRemove: (index: number) => void;
}

function AttachmentChip({ file, index, onRemove }: AttachmentChipProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImageFile(file)) return;
    const url = previewUrl(file);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <span
      key={`${file.name}-${file.lastModified}-${index}`}
      className="composer-attachment"
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          aria-hidden
          className="composer-attachment-thumb"
        />
      ) : (
        <Paperclip size={13} aria-hidden />
      )}
      <span className="composer-attachment-name">{file.name}</span>
      <button
        type="button"
        title={`Remove ${file.name}`}
        aria-label={`Remove attachment ${file.name}`}
        onClick={() => onRemove(index)}
      >
        <X size={12} aria-hidden />
      </button>
    </span>
  );
}

// ─── Slash-command menu ───────────────────────────────────────────────────────

interface SlashMenuProps {
  /** Pre-filtered commands, parent is the single source of truth. */
  commands: readonly SlashCommandHint[];
  activeIndex: number;
  onSelect: (name: string) => void;
  menuId: string;
  /** Base id prefix for option elements (enables aria-activedescendant). */
  optionIdPrefix: string;
}

function SlashMenu({ commands, activeIndex, onSelect, menuId, optionIdPrefix }: SlashMenuProps) {
  if (!commands.length) return null;

  return (
    <div
      id={menuId}
      role="listbox"
      aria-label="Slash commands"
      className="composer-slash-menu"
    >
      <div className="composer-slash-menu-label">Commands</div>
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          id={`${optionIdPrefix}-${i}`}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className="composer-slash-item"
          onMouseDown={(e) => {
            // Prevent textarea blur
            e.preventDefault();
            onSelect(cmd.name);
          }}
        >
          <span className="composer-slash-item-name">/{cmd.name}</span>
          <span className="composer-slash-item-desc">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Composer ─────────────────────────────────────────────────────────────────

export function Composer({
  layout = 'docked',
  placeholder = 'Message GoodVibes',
  draft,
  attachedFiles,
  isSendPending,
  sendError,
  turnError,
  renameSessionError,
  selectModelError,
  modelPicker,
  composerRef,
  fileInputRef,
  onDraftChange,
  onComposerKeyDown,
  onSubmit,
  onSteer,
  replyRunning = false,
  heldCommand = null,
  onSendHeldAsText,
  onFileSelection,
  onRemoveAttachedFile,
  slashCommands = [],
  onFilesAdded,
}: ComposerProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  // When true, the slash menu is suppressed for the current draft value.
  // Resets automatically when the draft changes to a non-slash or empty string.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashMenuId = useId();
  const slashOptionIdPrefix = `${slashMenuId}-opt`;

  const showSlashMenu =
    !slashDismissed &&
    slashCommands.length > 0 &&
    draft.startsWith('/') &&
    !draft.includes(' ');

  const filteredSlashCommands = showSlashMenu
    ? draft.length > 1
      ? slashCommands.filter((cmd) =>
          cmd.name.toLowerCase().startsWith(draft.slice(1).toLowerCase()),
        )
      : slashCommands
    : [];

  // Reset slash selection when filtered list changes
  useEffect(() => {
    setSlashActiveIndex(0);
  }, [filteredSlashCommands.length]);

  // Reset dismissed flag when draft changes out of slash territory
  useEffect(() => {
    if (!draft.startsWith('/') || draft.includes(' ')) {
      setSlashDismissed(false);
    }
  }, [draft]);

  // ── Drag-and-drop ──────────────────────────────────────────────────────────

  const handleDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dragHasFiles(event.nativeEvent)) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    // Only clear when leaving the form element entirely
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      event.preventDefault();
      setIsDragOver(false);
      const files = filesFromDrop(event.nativeEvent);
      if (!files.length) return;
      if (onFilesAdded) {
        // Typed callback path, no synthetic events needed.
        onFilesAdded(files);
      } else {
        // Fallback: push files into the hidden input so native onChange fires.
        const dt = new DataTransfer();
        for (const file of files) dt.items.add(file);
        if (fileInputRef.current) {
          fileInputRef.current.files = dt.files;
          fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    },
    [fileInputRef, onFilesAdded],
  );

  // ── Paste image from clipboard ─────────────────────────────────────────────

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = imageFilesFromPaste(event.nativeEvent);
      if (!images.length) return;
      // Prevent pasting the raw base64 text into the textarea
      event.preventDefault();
      if (onFilesAdded) {
        // Typed callback path, no synthetic events needed.
        onFilesAdded(images);
      } else {
        // Fallback: push images into the hidden input so native onChange fires.
        const dt = new DataTransfer();
        for (const file of images) dt.items.add(file);
        if (fileInputRef.current) {
          fileInputRef.current.files = dt.files;
          fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    },
    [fileInputRef, onFilesAdded],
  );

  // ── Slash-command keyboard handling ───────────────────────────────────────

  // Press-and-hold the send button = STEER (the touch counterpart of
  // Ctrl+Enter). The hold fires once at the threshold; the click that follows
  // pointer-up is suppressed so the form does not ALSO submit normally.
  const steerHoldTimerRef = useRef<number | null>(null);
  const steerHoldFiredRef = useRef(false);
  const startSteerHold = useCallback(() => {
    steerHoldFiredRef.current = false;
    // A second press (multi-touch, or a pointerup that never arrived) restarts the
    // hold: the earlier timer must not stay armed and fire a second steer.
    if (steerHoldTimerRef.current !== null) window.clearTimeout(steerHoldTimerRef.current);
    steerHoldTimerRef.current = window.setTimeout(() => {
      steerHoldTimerRef.current = null;
      steerHoldFiredRef.current = true;
      onSteer?.();
    }, 550);
  }, [onSteer]);
  const cancelSteerHold = useCallback(() => {
    if (steerHoldTimerRef.current !== null) {
      window.clearTimeout(steerHoldTimerRef.current);
      steerHoldTimerRef.current = null;
    }
  }, []);
  // Never fire a steer after the composer is gone.
  useEffect(() => () => {
    if (steerHoldTimerRef.current !== null) {
      window.clearTimeout(steerHoldTimerRef.current);
      steerHoldTimerRef.current = null;
    }
  }, []);
  const suppressClickAfterSteerHold = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (steerHoldFiredRef.current) {
      steerHoldFiredRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashMenu && filteredSlashCommands.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSlashActiveIndex((i) => Math.min(filteredSlashCommands.length - 1, i + 1));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSlashActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const selected = filteredSlashCommands[slashActiveIndex];
          // Enter on a command typed out in full runs it; Tab, or Enter on a prefix, completes it.
          const typedInFull = event.key === 'Enter' && selected !== undefined
            && draft.slice(1).toLowerCase() === selected.name.toLowerCase();
          if (selected && !typedInFull) {
            event.preventDefault();
            onDraftChange(`/${selected.name} `);
            return;
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          // Dismiss the menu without wiping the draft.
          setSlashDismissed(true);
          return;
        }
      }
      onComposerKeyDown(event);
    },
    [showSlashMenu, filteredSlashCommands, slashActiveIndex, draft, onDraftChange, onComposerKeyDown],
  );

  function handleSlashSelect(name: string) {
    onDraftChange(`/${name} `);
    composerRef.current?.focus();
  }

  // Dictated transcript lands in the draft for REVIEW BEFORE SENDING, appended after any
  // text already typed, never auto-sent.
  const handleTranscript = useCallback(
    (text: string) => {
      if (!text) return;
      onDraftChange(draft.trim() ? `${draft.trimEnd()} ${text}` : text);
      composerRef.current?.focus();
    },
    [draft, onDraftChange, composerRef],
  );

  const activeSlashOptionId =
    showSlashMenu && filteredSlashCommands.length > 0 && slashActiveIndex >= 0
      ? `${slashOptionIdPrefix}-${slashActiveIndex}`
      : undefined;

  const canSend = Boolean(draft.trim()) || attachedFiles.length > 0;
  // While a reply runs, Send queues the message behind it and the second control
  // interrupts. Ctrl/Cmd+Enter and holding Send stay as shortcuts for interrupting.
  const queueing = replyRunning && Boolean(onSteer);
  const paletteKey = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '') ? '⌘K' : 'Ctrl+K';
  const steerKey = paletteKey === '⌘K' ? '⌘+Enter' : 'Ctrl+Enter';

  return (
    <form
      className={`composer composer--${layout}`}
      onSubmit={onSubmit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {Boolean(sendError) && <div className="composer-error" role="alert">{formatError(sendError)}</div>}
      {turnError && <div className="composer-error" role="alert">{turnError}</div>}
      {Boolean(renameSessionError) && <div className="composer-error" role="alert">{formatError(renameSessionError)}</div>}
      {Boolean(selectModelError) && <div className="composer-error" role="alert">{formatError(selectModelError)}</div>}
      {heldCommand && (
        <div className="composer-error composer-command-note" role="alert">
          <span>
            {heldCommand.known
              ? `Not sent: ${heldCommand.word} takes nothing after it here. Send ${heldCommand.word} alone to start a new chat; ${paletteKey} opens every other command.`
              : `Not sent: ${heldCommand.word} is not a command here. Type /new to start a new chat; ${paletteKey} opens every other command.`}
          </span>
          {onSendHeldAsText && (
            <button type="button" className="composer-command-note__send" onClick={onSendHeldAsText}>
              Send as a message
            </button>
          )}
        </div>
      )}

      <div className="composer-box" data-drag-over={isDragOver ? 'true' : undefined}>
        {showSlashMenu && filteredSlashCommands.length > 0 && (
          <SlashMenu
            commands={filteredSlashCommands}
            activeIndex={slashActiveIndex}
            onSelect={handleSlashSelect}
            menuId={slashMenuId}
            optionIdPrefix={slashOptionIdPrefix}
          />
        )}

        {attachedFiles.length > 0 && (
          <div className="composer-attachments">
            {attachedFiles.map((file, index) => (
              <AttachmentChip
                key={`${file.name}-${file.lastModified}-${index}`}
                file={file}
                index={index}
                onRemove={onRemoveAttachedFile}
              />
            ))}
          </div>
        )}

        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          aria-label="Message GoodVibes"
          aria-autocomplete={showSlashMenu ? 'list' : undefined}
          aria-controls={showSlashMenu && filteredSlashCommands.length > 0 ? slashMenuId : undefined}
          aria-activedescendant={activeSlashOptionId}
          rows={1}
        />
        <input ref={fileInputRef} type="file" hidden multiple onChange={onFileSelection} />

        <div className="composer-toolbar">
          <button
            type="button"
            className="composer-tool composer-attach"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSendPending}
          >
            <Plus size={18} aria-hidden />
          </button>

          <div className="composer-toolbar__end">
            <ModelPicker {...modelPicker} />
            <MicButton onTranscript={handleTranscript} disabled={isSendPending} />
            <VoiceSettings />
            {queueing && (
              <button
                type="button"
                className="composer-interrupt"
                title={`Send now, interrupting the reply (${steerKey}, or hold Send)`}
                aria-label="Send now, interrupting the reply"
                disabled={isSendPending || !canSend}
                onClick={() => onSteer?.()}
              >
                Send now
              </button>
            )}
            <button
              type="submit"
              className="send-button"
              title={queueing
                ? `Queue after this reply (Enter). To interrupt: Send now, ${steerKey}, or hold this button.`
                : 'Send message (Enter)'}
              aria-label={queueing ? 'Queue message after this reply' : 'Send message'}
              data-queueing={queueing ? 'true' : undefined}
              data-ready={canSend && !isSendPending ? 'true' : undefined}
              data-pending={isSendPending ? 'true' : undefined}
              disabled={isSendPending || !canSend}
              onPointerDown={onSteer ? startSteerHold : undefined}
              onPointerUp={onSteer ? cancelSteerHold : undefined}
              onPointerLeave={onSteer ? cancelSteerHold : undefined}
              onPointerCancel={onSteer ? cancelSteerHold : undefined}
              onClick={onSteer ? suppressClickAfterSteerHold : undefined}
            >
              <ArrowUp size={18} aria-hidden />
              {queueing && <span className="send-button__word" aria-hidden>Queue</span>}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
