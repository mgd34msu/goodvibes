import { openHandlerMcpWorkspace } from '@goodvibes-jev/engine/terminal-shell/input-handler-state';
import { createFeedRenderBuffer, syncFeedContextLiveReferences } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
import { TerminalInputHandlerState } from '@goodvibes-jev/engine/terminal-shell/input-handler-state';
import {
  captureFeedContextMutable,
  projectFeedContextStable,
  projectFeedContextClosures,
} from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
import { syncFeedContextFromHost } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
import '@goodvibes-jev/engine/terminal-shell/composer-controller';
import { resolveFooterTarget } from '../renderer/footer-targets.ts';
import { SurfacePointer } from './surface-pointer.ts';
import 'node:fs';
import 'node:path';
import { InputTokenizer, type InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import { createOAuthLocalListener } from '@goodvibes-jev/engine/platform/platform/config';
import {
  clearModalStackForHandler,
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
  handleDiffApplyForHandler,
  handleEscapeForHandler,
  handlePasteForHandler,
  hydrateOnboardingWizardFromRuntimeForHandler,
  modalOpenedForHandler,
  openOnboardingWizardForHandler,
  registerPasteForHandler,
} from './handler-interactions.ts';
import { getViewportBottomLine } from '../renderer/conversation-layout.ts';
import {
  clearOnboardingModelPickerCancelStateForHandler,
  clearOnboardingPendingModelPickerTargetForHandler,
  completeOpenAiSubscriptionFromListenerForHandler,
  getOnboardingConfigValueForHandler,
  getOnboardingRuntimePostureForHandler,
  handleModelPickerCommitForHandler,
  handleOnboardingActionForHandler,
  handleOpenAiSubscriptionFinishForHandler,
  handleOpenAiSubscriptionStartForHandler,
  openModelPickerWithTargetForHandler,
  openProviderModelPickerWithTargetForHandler,
  refreshOnboardingHydrationForHandler,
  restartOnboardingExternalServicesIfNeededForHandler,
  restoreOnboardingModelPickerCancelStateForHandler,
  saveWizardProgressForHandler,
  syncRuntimeFromOnboardingRequestForHandler,
  verifyOnboardingRuntimePostureForHandler,
} from './handler-onboarding.ts';
import type { OnboardingRuntimePosture } from './handler-types.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/utils';
import '@/runtime/index.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult, SelectionOpenOptions } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import { InputHistory } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import { OverlayFilters } from './overlay-filter.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import { McpWorkspace } from './mcp-workspace.ts';
import { SessionPickerModal, getSharedHostedSessionRoster } from './session-picker-modal.ts';
import { ConfigModal } from './config-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import { OnboardingWizardController, type OnboardingWizardAction, type OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import '../runtime/onboarding/index.ts';
import type { OnboardingApplyRequest, OnboardingVerificationItem } from '../runtime/onboarding/index.ts';
import {
  cleanupMarkerRegistry,
  expandPrompt,
  findMarkerAtPos,
  handleBlockCopy,
  handleBlockSave,
  handleBlockToggle,
  handleBookmark,
  handleClipboardPaste,
  type ClipboardPasteSource,
  handleCopy,
  handleCtrlC,
  handleDiffApply,
  registerPaste,
} from './handler-content-actions.ts';
import { pasteFromClipboard, pasteImageFromClipboard } from '../utils/clipboard.ts';
import './handler-feed-routes.ts';
import { saveUndoState, shouldCoalesceUndo } from './handler-prompt-buffer.ts';
import { KillRing } from './kill-ring.ts';
import { beginConcealedInputFor, submitConcealedInputFor, cancelConcealedInputFor, type ConcealedInputRequest } from './concealed-input.ts';
import { clearModalStack, handleEscape, modalOpened } from './handler-modal-stack.ts';
import { SelectionModalQueue, attachSelectionModalQueue } from './selection-modal-queue.ts';
import './handler-modal-token-routes.ts';
import { type OnboardingWizardSnapshot, type OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import './handler-modal-routes.ts';
import './handler-command-route.ts';
import './handler-picker-routes.ts';
import './handler-shortcuts.ts';
import { feedInputTokens } from './handler-feed.ts';
import type { InputHandlerLike } from './handler-types.ts';
import { buildInitialFeedContext, syncFeedContextMutableFields } from './feed-context-factory.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { SurfaceModalHost } from './surface-modal-host.ts';

type SelectionModalCallback = (result: SelectionResult | null) => void;

/**
 * InputHandler - Owns prompt text, paste registry, and keyboard/mouse handling.
 * Extracted from main.ts and StateManager.
 */
export class InputHandler extends TerminalInputHandlerState implements InputHandlerLike {
  public hostPairing: { handleToken(token: InputToken): boolean; cancelForTakeover(): boolean; dispose(): void } | null = null;
  private draft = '';
  public draftRevision = 0;
  public get prompt(): string {
    return this.draft;
  }
  public set prompt(value: string) {
    if (value !== this.draft) this.draftRevision++;
    this.draft = value;
  }

  /**
   * Active concealed-input request, or null. When set, the composer masks its
   * echo (see getWrappedPromptInfo) and diverts submission to the request's
   * onSubmit (see submitConcealedInput) instead of the normal chat/command path,
   * so the plaintext never reaches input history or the transcript.
   */

  /** Max visible rows for the input area. Content beyond this scrolls internally. */
  public static readonly MAX_INPUT_ROWS = 8;
  /** Internal scroll offset for the input area when content exceeds MAX_INPUT_ROWS. */

  /** True when the user has entered slash-command mode (prompt starts with '/'). */

  /** True when the process indicator bar has keyboard focus. */

  public tokenizer = new InputTokenizer();

  /** Pending "hide the exit notice" timer from the last empty-prompt Ctrl+C
   * press, if any, cleared before every subsequent press decides its own
   * outcome (see handleCtrlC in handler-content-actions.ts). */
  public lastCtrlCTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Long-lived feed context, reused across every feed() call to avoid per-keystroke allocation. */
  public feedContext!: import('./handler-feed.ts').InputFeedContext;
  public commandRegistry: CommandRegistry | null = null;
  public commandContext: CommandContext | undefined = undefined;
  public autocomplete: AutocompleteEngine | null = null;
  public modelPicker: ModelPickerModal;
  public selectionModal = new SelectionModal();
  public searchManager = new SearchManager();
  public contextInspectorModal = new ContextInspectorModal();
  public readonly overlayFilters = new OverlayFilters();
  public bookmarkModal: BookmarkModal;
  public blockActionsMenu = new BlockActionsMenu();
  public surfaceModals = new SurfaceModalHost();
  /** Agent and process views (shell/session-views.ts); null until the shell wires them. */
  public sessionView: import('./handler-session-view-route.ts').SessionViewControls | null = null;
  /** The main transcript's scroll, for Esc while scrolled back (handler-modal-stack.ts); null until the shell wires it. */
  public transcriptScroll: import('./handler-modal-stack.ts').TranscriptScrollControls | null = null;
  /** Screen rows above the transcript, set each frame by the shell: the header, the chips, the gap under them. */

  public settingsModal = new SettingsModal();
  public configModal = new ConfigModal();
  public mcpWorkspace = new McpWorkspace();
  public onboardingWizard = new OnboardingWizardController();
  public onboardingModelPickerCancelSnapshot: OnboardingWizardSnapshot | null = null;
  public onboardingHydrationSerial = 0;
  public onboardingApplyPending = false;
  public onboardingOpenAiListenerSerial = 0;

  /**
   * Modal navigation stack. Each element is the name of an open modal.
   * Used to support back-navigation via Escape.
   */

  public sessionPickerModal: SessionPickerModal;
  public profilePickerModal: ProfilePickerModal;
  /** True when the help overlay is visible. */

  public filePicker: FilePickerModal;

  public conversationManager: ConversationManager | null = null;
  public selectionCallback: SelectionModalCallback | null = null;
  public get waitingForOwner(): boolean {
    return (
      this.concealedInput !== null ||
      (this.selectionModal.active && this.selectionCallback !== null) ||
      this.surfaceModals.waitingForOwner ||
      (this.settingsModal.active &&
        (this.settingsModal.mcpAllowAllConfirmationTarget !== null ||
          this.settingsModal.subscriptionLogoutConfirmationTarget !== null ||
          this.settingsModal.resetCategoryConfirm !== null ||
          this.settingsModal.resetAllConfirm !== null)) ||
      (this.configModal.active && this.configModal.hasPendingConfirm()) ||
      (this.sessionPickerModal.active && this.sessionPickerModal.deleteConfirmationTarget !== null) ||
      (this.profilePickerModal.active && this.profilePickerModal.deleteConfirmationTarget !== null)
    );
  }
  public syncFeedSelectionCallback: ((callback: SelectionModalCallback | null) => void) | null = null;
  /** FIFO queue for overlapping openSelection() calls, see selection-modal-queue.ts. */
  private selectionQueue!: SelectionModalQueue;
  /** Time of last [COPIED] block feedback, for brief display. */

  public readonly surfacePointer = new SurfacePointer();

  /** Clickable footer screen rows (set by the shell each frame) and what opens them. */
  public footerTargets: ReadonlyMap<number, import('../renderer/footer-targets.ts').FooterTarget> = new Map();
  public onFooterTarget: ((target: import('../renderer/footer-targets.ts').FooterTarget) => void) | null = null;

  /** Pasted images: maps marker IDs to base64 image data. */

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  /** Maximum undo groups retained. Oldest are evicted when the limit is hit. */
  public static readonly MAX_UNDO = 100;
  /** Timestamp (Date.now()) of the last saveUndoState call, used for coalescing. */
  public lastUndoMs = 0;
  /** Edit kind of the last saveUndoState call, used for coalescing. */
  public lastUndoKind: import('./handler-prompt-buffer.ts').EditKind = 'other';

  // ── Kill ring ───────────────────────────────────────────────────────────────
  public killRing = new KillRing();

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
    public readonly uiServices: Pick<UiRuntimeServices, 'agents' | 'environment' | 'platform' | 'providers' | 'sessions' | 'shell'>,
  ) {
    super(InputHandler.MAX_INPUT_ROWS);
    this.filePicker = new FilePickerModal(uiServices.environment.shellPaths);
    this.modelPicker = new ModelPickerModal(
      uiServices.providers.favoritesStore,
      uiServices.providers.benchmarkStore,
      uiServices.providers.providerRegistry,
    );
    this.bookmarkModal = new BookmarkModal(uiServices.shell.bookmarkManager);
    this.sessionPickerModal = new SessionPickerModal(
      uiServices.sessions.sessionManager,
      uiServices.sessions.sessionBroker,
      getSharedHostedSessionRoster(),
      () => this.requestRender(),
    ); // third source: the daemon-hosted roster
    this.profilePickerModal = new ProfilePickerModal(uiServices.shell.profileManager);
    this.selectionQueue = attachSelectionModalQueue(this); // wires exitApp teardown too, see selection-modal-queue.ts
    this.initFeedContext();
  }

  /**
   * initFeedContext, Build the long-lived InputFeedContext once via factory.
   * See feed-context-factory.ts for full field documentation.
   */
  public initFeedContext(): void {
    this.feedContext = buildInitialFeedContext(
      captureFeedContextMutable(this),
      {
        ...projectFeedContextStable(this),
        configModal: this.configModal,
        onboardingWizard: this.onboardingWizard,
        killRing: this.killRing,
      },
      {
        ...projectFeedContextClosures(this),
        handleDiffApply: () => this.handleDiffApply(),
        handleUndo: () => {
          this.handleUndo();
          this.syncFeedContextMutableFields();
        },
        handleRedo: () => {
          this.handleRedo();
          this.syncFeedContextMutableFields();
        },
        handlePaste: () => {
          this.handlePaste();
          this.syncFeedContextMutableFields();
        },
        saveUndoStateForText: () => this.saveUndoStateForText(),
        breakUndoCoalesce: () => {
          this.lastUndoKind = 'other';
        },
        footerTargetAt: (row: number, col?: number) => resolveFooterTarget(this.footerTargets, row, col),
        openFooterTarget: (target) => {
          this.onFooterTarget?.(target);
        },
        openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') =>
          this.openModelPickerWithTarget(target, source),
        openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') =>
          this.openProviderModelPickerWithTarget(target, source),
        onModelPickerCommit: () => this.handleModelPickerCommit(),
        onOnboardingAction: (action: OnboardingWizardAction) => {
          void this.handleOnboardingAction(action);
        },
        onStepChange: () => {
          saveWizardProgressForHandler(this);
        },
      },
    );
  }

  /** Sync mutable handler fields back into feedContext after in-feed mutations. */
  public syncFeedContextMutableFields(): void {
    syncFeedContextFromHost(this, this.feedContext);
  }

  /** Wire in the InputHistory instance. Optional; disables history navigation if unset. */
  public setHistory(history: InputHistory): void {
    this.inputHistory = history;
  }

  /** Wire in the slash command registry and context. Must be called before commands work. */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    this.autocomplete = new AutocompleteEngine(registry);
  }

  /** Wire in the conversation manager for block copy/apply/collapse. */
  public setConversationManager(cm: ConversationManager): void {
    this.conversationManager = cm;
  }

  /**
   * openSelection - Open the generic selection modal with a callback.
   * The callback receives SelectionResult on selection, or null on cancel/escape.
   * A second call while one is already showing queues FIFO instead of
   * overwriting it, see selection-modal-queue.ts.
   */
  public openSelection(
    title: string,
    items: import('./selection-modal.ts').SelectionItem[],
    opts: SelectionOpenOptions | undefined,
    callback: SelectionModalCallback,
  ): void {
    this.selectionQueue.request({ title, items, opts, callback });
  }

  public openOnboardingWizard(modeOrOptions: OnboardingWizardMode | OpenOnboardingWizardOptions = 'new'): void {
    openOnboardingWizardForHandler(this, modeOrOptions);
  }

  public async hydrateOnboardingWizardFromRuntime(hydrationSerial: number): Promise<void> {
    await hydrateOnboardingWizardFromRuntimeForHandler(this, hydrationSerial);
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
  /** The block the user is actually looking at: the viewport's bottom-most
   *  visible line (see getViewportBottomLine's doc), not the raw scrollTop,
   *  which is off-screen-above once the transcript exceeds one page. Every
   *  anchor-based block action (Ctrl+Y/B/S/A, Tab, the block-actions menu)
   *  resolves its target through this, so they all agree on what "nearest
   *  block" means. */
  public getBlockAnchorLine(): number {
    const lineCount = this.conversationManager?.history.getLineCount() ?? 0;
    return getViewportBottomLine(this.getScrollTop(), this.getViewportHeight(), lineCount);
  }
  public handleBlockToggle(): void {
    handleBlockToggleForHandler(this);
  }
  public handleDiffApply(): boolean {
    return handleDiffApplyForHandler(this);
  }
  public handleCtrlC(): void {
    handleCtrlCForHandler(this);
  }
  public modalOpened(name: string): void {
    this.hostPairing?.cancelForTakeover();
    modalOpenedForHandler(this, name);
  }
  public clearModalStack(): void {
    clearModalStackForHandler(this);
  }
  public handleEscape(): void {
    handleEscapeForHandler(this);
  }

  public clearOnboardingPendingModelPickerTarget(): void {
    clearOnboardingPendingModelPickerTargetForHandler(this);
  }
  public clearOnboardingModelPickerCancelState(): void {
    clearOnboardingModelPickerCancelStateForHandler(this);
  }
  public restoreOnboardingModelPickerCancelState(): void {
    restoreOnboardingModelPickerCancelStateForHandler(this);
  }
  public openModelPickerWithTarget(target: ModelPickerTarget, source: 'settings' | 'onboarding' = 'settings'): boolean {
    return openModelPickerWithTargetForHandler(this, target, source);
  }
  public openProviderModelPickerWithTarget(target: ModelPickerTarget, source: 'settings' | 'onboarding' = 'settings'): boolean {
    return openProviderModelPickerWithTargetForHandler(this, target, source);
  }
  public openMcpWorkspace(context: CommandContext): void {
    openHandlerMcpWorkspace(this, context);
  }
  public handleModelPickerCommit(): boolean {
    return handleModelPickerCommitForHandler(this);
  }
  public async handleOnboardingAction(action: OnboardingWizardAction): Promise<void> {
    await handleOnboardingActionForHandler(this, action);
  }
  public async refreshOnboardingHydration(
    options: { readonly preserveValues?: boolean; readonly targetStepId?: string } = {},
  ): Promise<void> {
    await refreshOnboardingHydrationForHandler(this, options);
  }
  public async handleOpenAiSubscriptionStart(): Promise<void> {
    await handleOpenAiSubscriptionStartForHandler(this);
  }
  public async completeOpenAiSubscriptionFromListener(
    listener: Awaited<ReturnType<typeof createOAuthLocalListener>>,
    verifier: string,
    serial: number,
  ): Promise<void> {
    await completeOpenAiSubscriptionFromListenerForHandler(this, listener, verifier, serial);
  }
  public async handleOpenAiSubscriptionFinish(): Promise<void> {
    await handleOpenAiSubscriptionFinishForHandler(this);
  }
  public syncRuntimeFromOnboardingRequest(request: ReturnType<OnboardingWizardController['buildApplyRequest']>): void {
    syncRuntimeFromOnboardingRequestForHandler(this, request);
  }
  public getOnboardingConfigValue(request: OnboardingApplyRequest, key: string): unknown {
    return getOnboardingConfigValueForHandler(this, request, key);
  }
  public getOnboardingRuntimePosture(request: OnboardingApplyRequest): OnboardingRuntimePosture {
    return getOnboardingRuntimePostureForHandler(this, request);
  }
  public async restartOnboardingExternalServicesIfNeeded(request: OnboardingApplyRequest): Promise<OnboardingVerificationItem[]> {
    return await restartOnboardingExternalServicesIfNeededForHandler(this, request);
  }
  public verifyOnboardingRuntimePosture(request: OnboardingApplyRequest): OnboardingVerificationItem[] {
    return verifyOnboardingRuntimePostureForHandler(this, request);
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
    // Snapshot the overlay flags before the feed: command handlers executed
    // synchronously during token processing (e.g. /shortcuts, /help via
    // ui-openers) mutate these directly on the handler, and an unconditional
    // write-back of the pre-feed snapshot would silently revert them in the
    // same keystroke (the "/shortcuts never displays" defect).
    const helpOverlayActiveBefore = this.helpOverlayActive;
    const helpScrollOffsetBefore = this.helpScrollOffset;
    const shortcutsOverlayActiveBefore = this.shortcutsOverlayActive;
    const shortcutsScrollOffsetBefore = this.shortcutsScrollOffset;
    try {
      const context = this.feedContext;
      syncFeedContextMutableFields(this, context);
      syncFeedContextLiveReferences(this, context);
      // Swap requestRender to buffered version for this feed.
      context.requestRender = bufferedRequestRender;
      this.syncFeedSelectionCallback = (callback) => {
        context.selectionCallback = callback;
      };
      context.handleHostPairingToken = (token) => this.hostPairing?.handleToken(token) ?? false;
      const tokens = this.tokenizer.feed(data);
      if (tokens.some((token) => token.type === 'mouse')) {
        let pending: typeof tokens = [];
        for (const token of tokens) {
          if (token.type !== 'mouse') {
            pending.push(token);
            continue;
          }
          if (pending.length) {
            feedInputTokens(context, pending);
            pending = [];
          }
          const routed = this.surfacePointer.route(token);
          if (routed.length) feedInputTokens(context, routed);
          if (token.button !== 32) bufferedRequestRender();
        }
        if (pending.length) feedInputTokens(context, pending);
      } else feedInputTokens(context, tokens);
      this.prompt = context.prompt;
      this.cursorPos = context.cursorPos;
      this.inputScrollTop = context.inputScrollTop;
      this.commandMode = context.commandMode;
      this.indicatorFocused = context.indicatorFocused;
      // Overlay flags: only apply the pipeline's value when the pipeline
      // itself changed it (e.g. Escape closing the overlay). Otherwise keep
      // the live handler value, which a command handler may have just set.
      if (context.helpOverlayActive !== helpOverlayActiveBefore) this.helpOverlayActive = context.helpOverlayActive;
      if (context.helpScrollOffset !== helpScrollOffsetBefore) this.helpScrollOffset = context.helpScrollOffset;
      if (context.shortcutsOverlayActive !== shortcutsOverlayActiveBefore) this.shortcutsOverlayActive = context.shortcutsOverlayActive;
      if (context.shortcutsScrollOffset !== shortcutsScrollOffsetBefore) this.shortcutsScrollOffset = context.shortcutsScrollOffset;
      this.selectionCallback = context.selectionCallback;
      this.nextPasteId = context.nextPasteId;
      this.nextImageId = context.nextImageId;
      this.mouseDownRow = context.mouseDownRow;
      this.mouseDownCol = context.mouseDownCol;
    } finally {
      this.syncFeedSelectionCallback = null;
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

  /** Begin one line of concealed (masked) composer input. See concealed-input.ts. */
  public beginConcealedInput(request: ConcealedInputRequest): void {
    this.hostPairing?.cancelForTakeover();
    beginConcealedInputFor(this, request);
  }
  /** True while a concealed-input request is active. */
  public isConcealedInput(): boolean {
    return this.concealedInput !== null;
  }
  /** Deliver a concealed submission; returns true when concealed mode consumed it. */
  public submitConcealedInput(value: string): boolean {
    return submitConcealedInputFor(this, value);
  }
  /** Cancel an active concealed-input request without submitting (Escape). */
  public cancelConcealedInput(): boolean {
    return cancelConcealedInputFor(this);
  }

  // ── Undo / Redo methods ─────────────────────────────────────────────────

  /**
   * saveUndoState - Unconditionally snapshot current prompt + cursor onto the
   * undo stack (kill, yank, delete, or other non-text edits). Clears redo stack.
   */
  public saveUndoState(): void {
    saveUndoState(this.undoStack, this.redoStack, this.prompt, this.cursorPos, InputHandler.MAX_UNDO);
    this.lastUndoMs = Date.now();
    this.lastUndoKind = 'other';
  }

  /**
   * saveUndoStateForText - Snapshot with coalescing for plain text insertions.
   * Consecutive text edits within UNDO_COALESCE_MS are merged into one group
   * (the snapshot is skipped; the group absorbs the characters typed in the
   * burst). Cursor moves, kill, and yank operations break the group.
   *
   * Call this instead of saveUndoState() from the text-insertion path only.
   */
  public saveUndoStateForText(): void {
    const now = Date.now();
    if (shouldCoalesceUndo(this.lastUndoKind, 'text', this.lastUndoMs, now)) {
      // Coalesce: skip the snapshot but update the timestamp so the window
      // keeps sliding until the burst ends.
      this.lastUndoMs = now;
      return;
    }
    saveUndoState(this.undoStack, this.redoStack, this.prompt, this.cursorPos, InputHandler.MAX_UNDO);
    this.lastUndoMs = now;
    this.lastUndoKind = 'text';
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
