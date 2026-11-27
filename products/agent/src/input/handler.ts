import { openHandlerMcpWorkspace } from '@goodvibes/engine/terminal-shell/input-handler-state';
import { createFeedRenderBuffer, syncFeedContextLiveReferences } from '@goodvibes/engine/terminal-shell/input-feed-context';
import { TerminalInputHandlerState } from '@goodvibes/engine/terminal-shell/input-handler-state';
import {
  projectFeedContextStable,
  projectFeedContextClosures,
} from '@goodvibes/engine/terminal-shell/input-feed-context';
import { InputTokenizer } from '@goodvibes/engine/platform/platform/core';
import { reportDroppedPaste } from '@goodvibes/engine/terminal-shell/input-content';
import { resolveFooterTarget, type FooterTarget } from '../renderer/footer-targets.ts';
import {
  cleanupMarkerRegistryForHandler,
  executeBlockActionForHandler,
  expandPromptForHandler,
  findMarkerAtPosForHandler,
  getImageAttachmentsForHandler,
  handleBlockCopyForHandler,
  handleBlockSaveForHandler,
  handleBlockToggleForHandler,
  handleBookmarkForHandler,
  handleCopyForHandler,
  handleCtrlCForHandler,
  handleEscapeForHandler,
  handlePasteForHandler,
  registerPasteForHandler,
} from './handler-interactions.ts';
import { SelectionManager } from '@goodvibes/engine/terminal-shell';
import type { InfiniteBuffer } from '@goodvibes/engine/terminal-shell';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import { attachSelectionModalQueue, type SelectionModalQueue } from '@goodvibes/engine/terminal-shell/selection-modal-queue';
import type { SelectionResult, SelectionOpenOptions } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import { InputHistory } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import { SurfaceModalHost, type TrackedModal } from '@goodvibes/engine/terminal-shell/surface-modal-host';
import { BookmarkModal } from './bookmark-modal.ts';
import { McpWorkspace } from './mcp-workspace.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import {
  cleanupMarkerRegistry,
  expandPrompt,
  findMarkerAtPos,
  handleBlockCopy,
  handleBlockSave,
  handleBlockToggle,
  handleBookmark,
  handleClipboardPaste,
  handleCopy,
  handleCtrlC,
  registerPaste,
} from './handler-content-actions.ts';
import { saveUndoState } from './handler-prompt-buffer.ts';
import { createHandlerModals, ownModal, type HandlerModals } from './handler-modal-stack.ts';
import { type ConcealedInputRequest } from './concealed-input.ts';
import type { PlainLineInputRequest } from './plain-line-input.ts';
import {
  beginConcealedInputForHandler,
  beginPlainInputForHandler,
  submitLinePromptForHandler,
  cancelLinePromptForHandler,
} from './handler-line-prompts.ts';
import { pasteImageFromClipboard, pasteFromClipboard } from '../utils/clipboard.ts';
import type { ClipboardPasteSource } from './handler-content-actions.ts';
import { feedInputTokens } from './handler-feed.ts';
import { SurfacePointer } from '@goodvibes/engine/terminal-shell/surface-pointer';
import { buildInitialFeedContext } from './feed-context-factory.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import type { PasteBurstGuardState } from './paste-flood-guard.ts';

type SelectionModalCallback = (result: SelectionResult | null) => void;

/**
 * InputHandler - Owns prompt text, paste registry, and keyboard/mouse handling.
 * Extracted from main.ts and StateManager.
 */
export class InputHandler extends TerminalInputHandlerState {
  public prompt = '';

  /**
   * Active concealed-input request, or null. When set, the composer masks its
   * echo (see getWrappedPromptInfo) and diverts submission to the request's
   * onSubmit (see submitConcealedInput) instead of the normal chat/command
   * path, so the plaintext never reaches input history or the transcript.
   */

  /**
   * Active plain-line request, or null. Same chaining shape as concealedInput
   * but echoed normally, see plain-line-input.ts for why the two are separate
   * slots rather than one type with a masking flag. At most one of the two is
   * ever set; the begin* methods below enforce that.
   */
  public plainLineInput: PlainLineInputRequest | null = null;
  /** Max visible rows for the input area. Content beyond this scrolls internally. */
  public static readonly MAX_INPUT_ROWS = 8;
  /** Internal scroll offset for the input area when content exceeds MAX_INPUT_ROWS. */

  /** True when the user has entered slash-command mode (prompt starts with '/'). */

  /** True when the process indicator bar has keyboard focus. */

  public tokenizer = new InputTokenizer();

  /** Unbracketed-paste-flood guard state (shared guard in terminal-shell), mutated in place. */
  public burstGuard: PasteBurstGuardState = { timestamps: [], suspended: false, hintShown: false };
  /** Long-lived feed context, reused across every feed() call to avoid per-keystroke allocation. */
  public feedContext!: import('./handler-feed.ts').InputFeedContext;
  public commandRegistry: CommandRegistry | null = null;
  public commandContext: CommandContext | undefined = undefined;
  public autocomplete: AutocompleteEngine | null = null;
  public modelPicker: ModelPickerModal;
  public selectionModal = new SelectionModal();
  public searchManager = new SearchManager();
  public processModal: ProcessModal;
  public liveTailModal: LiveTailModal;
  public contextInspectorModal = new ContextInspectorModal();
  /** The one stack of open modals: kit modals and the handler's own, one Esc level at a time (terminal-shell/surface-modal-host). */
  public surfaceModals = new SurfaceModalHost();
  /** The mouse over the last painted frame: a kit modal's rows, tabs and keycaps are clickable (terminal-shell/surface-pointer). */
  public readonly surfacePointer = new SurfacePointer();
  /** The handler's own modals as objects on that stack: the shared ones, the process monitor and its live tail. */
  public readonly modals: HandlerModals & {
    readonly process: TrackedModal;
    readonly liveTail: TrackedModal;
  };
  /** Agent and process views (shell/session-views.ts); null until the shell wires them. */
  public sessionView: import('./handler-session-view-route.ts').SessionViewControls | null = null;
  /** The main transcript's scroll, for Esc while scrolled back (handler-modal-stack.ts); null until the shell wires it. */
  public transcriptScroll: import('./handler-modal-stack.ts').TranscriptScrollControls | null = null;
  /** Screen rows above the transcript, set each frame by the shell: the header, the chips, the gap under them. */

  public bookmarkModal: BookmarkModal;
  public blockActionsMenu = new BlockActionsMenu();
  public mcpWorkspace = new McpWorkspace();
  /** Screen row → what a click on that status bar row (and column) opens; set each frame. */
  public footerTargets: ReadonlyMap<number, FooterTarget> = new Map();
  /** Opens what a clicked status bar segment names; wired by the shell. */
  public onFooterTarget: ((target: FooterTarget) => void) | null = null;

  public sessionPickerModal: SessionPickerModal;
  /** True when the help overlay is visible. */

  public filePicker: FilePickerModal;

  public conversationManager: ConversationManager | null = null;
  public selectionCallback: SelectionModalCallback | null = null;

  get waitingForOwner(): boolean {
    return (
      (this.selectionModal.active && this.selectionCallback !== null) ||
      this.concealedInput !== null ||
      this.plainLineInput !== null ||
      this.surfaceModals.waitingForOwner ||
      (this.sessionPickerModal.active && this.sessionPickerModal.deleteConfirmationTarget !== null)
    );
  }
  /** Time of last [COPIED] block feedback, for brief display. */

  /** Pasted images: maps marker IDs to base64 image data. */

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  public static readonly MAX_UNDO = 50;

  // ── Path completion (Tab on path-like token) ───────────────────────────────
  /** Current list of path completions cycling on repeated Tab presses. */

  /** Index into pathCompletions for Tab cycling. */

  /** The raw prefix that triggered path completion (e.g. 'src/in'). */

  /** Start offset in prompt where the path token begins. */

  constructor(
    public requestRender: () => void,
    public selection: SelectionManager,
    public getScrollTop: () => number,
    public getViewportHeight: () => number,
    public getHistory: () => InfiniteBuffer,
    public scroll: (delta: number) => void,
    public exitApp: () => void,
    public readonly uiServices: Pick<UiRuntimeServices, 'environment' | 'platform' | 'providers' | 'sessions' | 'shell'>,
  ) {
    super(InputHandler.MAX_INPUT_ROWS);
    this.filePicker = new FilePickerModal(uiServices.environment.shellPaths);
    this.modelPicker = new ModelPickerModal(
      uiServices.providers.favoritesStore,
      uiServices.providers.benchmarkStore,
      uiServices.providers.providerRegistry,
    );
    this.processModal = new ProcessModal({
      processManager: uiServices.shell.processManager,
    });
    this.liveTailModal = new LiveTailModal({
      processManager: uiServices.shell.processManager,
    });
    this.bookmarkModal = new BookmarkModal(uiServices.shell.bookmarkManager);
    this.sessionPickerModal = new SessionPickerModal(uiServices.sessions.sessionManager);
    this.selectionQueue = attachSelectionModalQueue(this);
    this.modals = {
      ...createHandlerModals(this, { clearCommandText: true }),
      process: ownModal('process', () => this.processModal, () => this.processModal.open()),
      liveTail: ownModal('liveTail', () => this.liveTailModal),
    };
    const modals = this.modals;
    this.surfaceModals.track(
      modals.command,
      modals.mcpWorkspace,
      modals.process,
      modals.liveTail,
      modals.sessionPicker,
      modals.bookmark,
      modals.contextInspector,
      modals.modelPicker,
      modals.filePicker,
      modals.blockActions,
      modals.selection,
    );
    this.surfaceModals.onOpen = (_modal, fromEmpty) => {
      if (fromEmpty) this.modalReturnFocus = this.indicatorFocused ? 'indicator' : 'prompt';
    };
    this.initFeedContext();
  }

  /**
   * initFeedContext, Build the long-lived InputFeedContext once via factory.
   * See feed-context-factory.ts for full field documentation.
   */
  public initFeedContext(): void {
    this.feedContext = buildInitialFeedContext(
      this,
      {
        ...projectFeedContextStable(this),
        burstGuard: this.burstGuard,
        processModal: this.processModal,
        liveTailModal: this.liveTailModal,
      },
      {
        ...projectFeedContextClosures(this),
        handleUndo: () => {
          this.handleUndo();
          return this.promptEdit();
        },
        handleRedo: () => {
          this.handleRedo();
          return this.promptEdit();
        },
        handlePaste: () => {
          this.handlePaste();
          return this.promptEdit();
        },
        footerTargetAt: (row: number, col?: number) => resolveFooterTarget(this.footerTargets, row, col),
        openFooterTarget: (target: FooterTarget) => {
          this.onFooterTarget?.(target);
        },
        openModelPickerWithTarget: (target: ModelPickerTarget) => this.openModelPickerWithTarget(target),
        openProviderModelPickerWithTarget: (target: ModelPickerTarget) => this.openProviderModelPickerWithTarget(target),
        onModelPickerCommit: () => this.handleModelPickerCommit(),
      },
    );
  }

  /** Where the prompt currently sits, for callers that must copy it forward. */
  public promptEdit(): { readonly prompt: string; readonly cursorPos: number } {
    return { prompt: this.prompt, cursorPos: this.cursorPos };
  }

  /** Wire in the InputHistory instance. Optional; disables history navigation if unset. */
  public setHistory(history: InputHistory): void {
    this.inputHistory = history;
  }

  /** Wire in the slash command registry and context. Must be called before commands work. */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    // The root context serves agent_harness run_keybinding and run_command; without this their paste would find no route and report unavailable. A typed command still gets its own composer-bound copy from the command route.
    context.pasteFromClipboard ??= () => this.handlePaste();
    // A described command's blanks complete from its live lists, read with this context only once the dropdown asks.
    this.autocomplete = new AutocompleteEngine(registry, { context: () => this.commandContext, rowsArrived: () => this.requestRender() });
  }

  /** Wire in the conversation manager for block copy/collapse. */
  public setConversationManager(cm: ConversationManager): void {
    this.conversationManager = cm;
  }

  /**
   * openSelection - Open the generic selection modal with a callback.
   * The callback receives SelectionResult on selection, or null on cancel/escape.
   */
  private readonly selectionQueue: SelectionModalQueue;

  public openSelection(
    title: string,
    items: import('./selection-modal.ts').SelectionItem[],
    opts: SelectionOpenOptions | undefined,
    callback: SelectionModalCallback,
  ): void {
    // A question that opened by itself reads the composer, so typing in flight and a draft stay there.
    const withComposer = opts?.unprompted ? { ...opts, composerEmpty: () => this.prompt.length === 0 } : opts;
    this.selectionQueue.request({ title, items, opts: withComposer, callback });
  }

  public registerPaste(content: string): string {
    return registerPasteForHandler(this, content);
  }
  public expandPrompt(text: string) {
    return expandPromptForHandler(this, text);
  }
  public getImageAttachments(): Map<string, { data: string; mediaType: string }> {
    return getImageAttachmentsForHandler(this);
  }
  public cleanupMarkerRegistry(markerText: string): void {
    cleanupMarkerRegistryForHandler(this, markerText);
  }
  public findMarkerAtPos(pos: number): { start: number; end: number } | null {
    return findMarkerAtPosForHandler(this, pos);
  }
  public handleCopy(): void {
    handleCopyForHandler(this);
  }
  public handleBlockCopy(): void {
    handleBlockCopyForHandler(this);
  }
  public handleBookmark(): void {
    handleBookmarkForHandler(this);
  }
  public handleBlockSave(): void {
    handleBlockSaveForHandler(this);
  }
  public executeBlockAction(actionId: string): void {
    executeBlockActionForHandler(this, actionId);
  }
  public handleBlockToggle(): void {
    handleBlockToggleForHandler(this);
  }
  public handleCtrlC(): void {
    handleCtrlCForHandler(this);
  }
  public handleEscape(): void {
    handleEscapeForHandler(this);
  }

  // ── Composer line prompts (see handler-line-prompts.ts) ─────────────────

  /** Begin one line of masked composer entry. */
  public beginConcealedInput(request: ConcealedInputRequest): void {
    beginConcealedInputForHandler(this, request);
  }

  /** Begin one line of ordinary, echoed composer entry. */
  public beginPlainInput(request: PlainLineInputRequest): void {
    beginPlainInputForHandler(this, request);
  }

  /** Deliver an Enter to a pending line prompt. True means it was consumed. */
  public submitConcealedInput(value: string): boolean {
    return submitLinePromptForHandler(this, value);
  }

  /** Cancel a pending line prompt of either kind (Escape). */
  public cancelConcealedInput(): boolean {
    return cancelLinePromptForHandler(this);
  }

  public openModelPickerWithTarget(target: ModelPickerTarget): boolean {
    const openModelPicker = this.commandContext?.openModelPicker;
    if (!openModelPicker) return false;
    this.modelPicker.target = target;
    openModelPicker();
    return true;
  }
  public openProviderModelPickerWithTarget(target: ModelPickerTarget): boolean {
    const openProviderPicker = this.commandContext?.openProviderPicker;
    if (!openProviderPicker) return false;
    this.modelPicker.target = target;
    openProviderPicker();
    return true;
  }
  public openMcpWorkspace(context: CommandContext): void {
    openHandlerMcpWorkspace(this, context);
  }
  public handleModelPickerCommit(): boolean {
    return false;
  }

  /**
   * feed - Process raw stdin data through the tokenizer.
   * Reuses the long-lived this.feedContext to avoid per-keystroke object allocation.
   */
  public feed(data: string): void {
    const immediateRequestRender = this.requestRender;
    const renderBuffer = createFeedRenderBuffer(immediateRequestRender);
    const bufferedRequestRender = renderBuffer.requestRender;

    this.requestRender = bufferedRequestRender;
    try {
      const context = this.feedContext;
      syncFeedContextLiveReferences(this, context);
      // Swap requestRender to buffered version for this feed.
      context.requestRender = bufferedRequestRender;
      const tokens = this.tokenizer.feed(data);
      // A mouse token goes through the pointer first: over a kit modal it is a click on what was painted there.
      const routed = tokens.some((token) => token.type === 'mouse') ? tokens.flatMap((token) => this.surfacePointer.route(token)) : tokens;
      feedInputTokens(context, routed);
      reportDroppedPaste(this.tokenizer, this.conversationManager, bufferedRequestRender);
    } finally {
      renderBuffer.release();
      this.requestRender = immediateRequestRender;
    }

    renderBuffer.flush();
  }

  /**
   * handlePaste - Shared paste logic for Ctrl+V and middle-click.
   * Tries image clipboard first, falls back to text paste.
   */
  public handlePaste(): ReturnType<typeof handleClipboardPaste> {
    return handlePasteForHandler(this);
  }

  /**
   * The clipboard this composer pastes from. Swappable so tests can supply a
   * clipboard instead of reaching for the machine's real one.
   */
  public clipboardSource: ClipboardPasteSource = { pasteImageFromClipboard, pasteFromClipboard };

  /** Content width for wrapping, set by main.ts via setContentWidth(). */

  /** Set the content width used for wrapping calculations. Call from main.ts. */

  /**
   * Move cursor up or down by one WRAPPED line.
   * Uses the segment table to navigate visual lines, not raw \n lines.
   * Returns true if the cursor moved, false if at boundary.
   */

  /**
   * Ensure the cursor's wrapped line is visible within the input scroll window.
   */

  /**
   * Get the number of visible prompt lines (capped at MAX_INPUT_ROWS),
   * accounting for word-wrapping within the content width.
   */

  /**
   * Word-wrap the prompt and compute cursor display coordinates.
   * Returns wrapped lines, the cursor's position in wrapped coordinates,
   * and the visible slice respecting inputScrollTop.
   */

  // ── Undo / Redo methods ─────────────────────────────────────────────────

  /**
   * saveUndoState - Snapshot current prompt + cursor onto the undo stack.
   * Clears the redo stack because a new edit invalidates future states.
   */
  public saveUndoState(): void {
    saveUndoState(this.undoStack, this.redoStack, this.prompt, this.cursorPos, InputHandler.MAX_UNDO);
  }

  /**
   * handleUndo - Ctrl+Z: pop from undo stack, push current to redo stack.
   */

  /**
   * handleRedo - Ctrl+Shift+Z: pop from redo stack, push current to undo stack.
   */

  // ── Path completion methods ─────────────────────────────────────────────

  /**
   * findPathToken - Scan backward from cursor to find a path-like token.
   * Detects:
   *   - !@<partial>  (inject mode)
   *   - @<partial>   (normal file ref)
   *   - plain word containing '/'
   * Returns { start, prefix } or null if no path token found.
   */
  /**
   * handlePathCompletion - Tab on a path-like token: fuzzy-complete from filePicker.allFiles.
   * Repeated Tab cycles through matches.
   * Returns true if path completion was performed.
   */


  /**
   * Word-wrap a single line to fit within maxW columns.
   * Breaks at spaces; words wider than maxW are force-broken.
   */
}
