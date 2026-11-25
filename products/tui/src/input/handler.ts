import { openHandlerMcpWorkspace } from '@goodvibes/engine/terminal-shell/input-handler-state';
import { createFeedRenderBuffer, syncFeedContextLiveReferences } from '@goodvibes/engine/terminal-shell/input-feed-context';
import { TerminalInputHandlerState } from '@goodvibes/engine/terminal-shell/input-handler-state';
import {
  projectFeedContextStable,
  projectFeedContextClosures,
} from '@goodvibes/engine/terminal-shell/input-feed-context';
import { resolveFooterTarget } from '../renderer/footer-targets.ts';
import { SurfacePointer } from '@goodvibes/engine/terminal-shell/surface-pointer';
import { InputTokenizer, type InputToken } from '@goodvibes/engine/platform/platform/core';
import { reportDroppedPaste } from '@goodvibes/engine/terminal-shell/input-content';
import { createOAuthLocalListener } from '@goodvibes/engine/platform/platform/config';
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
  handleDiffApplyForHandler,
  handleEscapeForHandler,
  handlePasteForHandler,
  hydrateOnboardingWizardFromRuntimeForHandler,
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
  syncRuntimeFromOnboardingRequestForHandler,
  verifyOnboardingRuntimePostureForHandler,
} from './handler-onboarding.ts';
import type { OnboardingRuntimePosture } from './handler-types.ts';
import { SelectionManager } from '@goodvibes/engine/terminal-shell';
import type { InfiniteBuffer } from '@goodvibes/engine/terminal-shell';
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
import { BookmarkModal } from './bookmark-modal.ts';
import { McpWorkspace } from './mcp-workspace.ts';
import { SessionPickerModal, getSharedHostedSessionRoster } from './session-picker-modal.ts';
import { ConfigModal } from './config-modal.ts';
import { ProfilePickerModal } from '@goodvibes/engine/terminal-shell/profile-picker-state';
import { OnboardingWizardController, type OnboardingFormOutcome, type OnboardingWizardAction, type OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import type { OnboardingApplyRequest, OnboardingVerificationItem } from '../runtime/onboarding/index.ts';
import { handleClipboardPaste, type ClipboardPasteSource } from './handler-content-actions.ts';
import { pasteFromClipboard, pasteImageFromClipboard } from '../utils/clipboard.ts';
import { saveUndoState, shouldCoalesceUndo } from './handler-prompt-buffer.ts';
import { KillRing } from './kill-ring.ts';
import { beginConcealedInputFor, submitConcealedInputFor, cancelConcealedInputFor, type ConcealedInputRequest } from './concealed-input.ts';
import { createHandlerModals, ownModal } from './handler-modal-stack.ts';
import { SelectionModalQueue, attachSelectionModalQueue } from './selection-modal-queue.ts';
import { type OnboardingWizardSnapshot, type OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import { feedInputTokens } from './handler-feed.ts';
import type { InputHandlerLike } from './handler-types.ts';
import { buildInitialFeedContext } from './feed-context-factory.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { SurfaceModalHost, isTrackedModal } from '@goodvibes/engine/terminal-shell/surface-modal-host';

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

  /** Max visible rows for the input area. Content beyond this scrolls internally. */
  public static readonly MAX_INPUT_ROWS = 8;

  public tokenizer = new InputTokenizer();

  /** Pending "hide the exit notice" timer from the last empty-prompt Ctrl+C
   * press, if any, cleared before every subsequent press decides its own
   * outcome (see handleCtrlC in handler-content-actions.ts). */
  public lastCtrlCTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Unbracketed-paste-flood guard state (shared guard in terminal-shell), mutated in place. */
  public burstGuard: import('@goodvibes/engine/terminal-shell/paste-flood-guard').PasteBurstGuardState = { timestamps: [], suspended: false, hintShown: false };
  /** Long-lived feed context, reused across every feed() call to avoid per-keystroke allocation. */
  public feedContext!: import('./handler-feed.ts').InputFeedContext;
  public commandRegistry: CommandRegistry | null = null;
  public commandContext: CommandContext | undefined = undefined;
  public autocomplete: AutocompleteEngine | null = null;
  public modelPicker: ModelPickerModal;
  public selectionModal = new SelectionModal();
  public searchManager = new SearchManager();
  public contextInspectorModal = new ContextInspectorModal();
  public bookmarkModal: BookmarkModal;
  public blockActionsMenu = new BlockActionsMenu();
  /** The one stack of open modals: kit modals and the handler's own (surface-modal-host.ts). */
  public surfaceModals = new SurfaceModalHost();
  /** The handler's own modals as objects on that stack. */
  public readonly modals: InputHandlerLike['modals'];
  /** Agent and process views (shell/session-views.ts); null until the shell wires them. */
  public sessionView: import('./handler-session-view-route.ts').SessionViewControls | null = null;
  /** The main transcript's scroll, for Esc while scrolled back (handler-modal-stack.ts); null until the shell wires it. */
  public transcriptScroll: import('./handler-modal-stack.ts').TranscriptScrollControls | null = null;

  public configModal = new ConfigModal();
  public mcpWorkspace = new McpWorkspace();
  public onboardingWizard = new OnboardingWizardController();
  public onboardingModelPickerCancelSnapshot: OnboardingWizardSnapshot | null = null;
  public onboardingHydrationSerial = 0;
  /** The onboarding operation running now, by name, so another key press can say what it waits for; null when none. */
  public onboardingOperation: string | null = null;
  /** The OpenAI sign-in's callback listener while it waits on the fixed port; null when none is held. */
  public onboardingOpenAiListener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;

  public sessionPickerModal: SessionPickerModal;
  public profilePickerModal: ProfilePickerModal;

  public filePicker: FilePickerModal;

  public conversationManager: ConversationManager | null = null;
  public selectionCallback: SelectionModalCallback | null = null;
  public get waitingForOwner(): boolean {
    return (
      this.concealedInput !== null ||
      (this.selectionModal.active && this.selectionCallback !== null) ||
      this.surfaceModals.waitingForOwner ||
      (this.configModal.active && this.configModal.hasPendingConfirm()) ||
      (this.sessionPickerModal.active && this.sessionPickerModal.deleteConfirmationTarget !== null) ||
      (this.profilePickerModal.active && this.profilePickerModal.deleteConfirmationTarget !== null)
    );
  }
  /** FIFO queue for overlapping openSelection() calls, see selection-modal-queue.ts. */
  private selectionQueue!: SelectionModalQueue;

  public readonly surfacePointer = new SurfacePointer();

  /** Clickable footer screen rows (set by the shell each frame) and what opens them. */
  public footerTargets: ReadonlyMap<number, import('../renderer/footer-targets.ts').FooterTarget> = new Map();
  public onFooterTarget: ((target: import('../renderer/footer-targets.ts').FooterTarget) => void) | null = null;

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  /** Maximum undo groups retained. Oldest are evicted when the limit is hit. */
  public static readonly MAX_UNDO = 100;
  /** Timestamp (Date.now()) of the last saveUndoState call, used for coalescing. */
  public lastUndoMs = 0;
  /** Edit kind of the last saveUndoState call, used for coalescing. */
  public lastUndoKind: import('./handler-prompt-buffer.ts').EditKind = 'other';

  // ── Kill ring ───────────────────────────────────────────────────────────────
  public killRing = new KillRing();

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
      () => this.commandContext?.session.runtime.sessionId,
    ); // third source: the daemon-hosted roster
    this.profilePickerModal = new ProfilePickerModal(uiServices.shell.profileManager);
    this.selectionQueue = attachSelectionModalQueue(this); // wires exitApp teardown too, see selection-modal-queue.ts
    this.modals = {
      ...createHandlerModals(this, {
        clearCommandText: false,
        afterModelPickerClose: () => this.restoreOnboardingModelPickerCancelState(),
      }),
      config: ownModal('config', () => this.configModal, () => this.configModal.reopen()),
      onboarding: {
        ...ownModal('onboarding', () => this.onboardingWizard, () => this.onboardingWizard.reopen()),
        close: () => {
          this.onboardingWizard.close();
          this.clearOnboardingModelPickerCancelState();
        },
      },
    };
    const modals = this.modals;
    this.surfaceModals.track(
      modals.command,
      modals.onboarding,
      modals.config,
      modals.mcpWorkspace,
      modals.sessionPicker,
      modals.profilePicker,
      modals.bookmark,
      modals.contextInspector,
      modals.modelPicker,
      modals.filePicker,
      modals.blockActions,
      modals.selection,
    );
    this.surfaceModals.onOpen = (modal, fromEmpty) => {
      if (fromEmpty) this.modalReturnFocus = this.indicatorFocused ? 'indicator' : 'prompt';
      if (isTrackedModal(modal)) this.hostPairing?.cancelForTakeover();
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
        configModal: this.configModal,
        onboardingWizard: this.onboardingWizard,
        killRing: this.killRing,
      },
      {
        ...projectFeedContextClosures(this),
        handleUndo: () => {
          this.handleUndo();
        },
        handleRedo: () => {
          this.handleRedo();
        },
        handlePaste: () => {
          this.handlePaste();
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
      },
    );
  }

  /** Wire in the InputHistory instance. Optional; disables history navigation if unset. */
  public setHistory(history: InputHistory): void {
    this.inputHistory = history;
  }

  /** Wire in the slash command registry and context. Must be called before commands work. */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    // A described command's blanks complete from its live lists, read with this context only once the dropdown asks.
    this.autocomplete = new AutocompleteEngine(registry, { context: () => this.commandContext, rowsArrived: () => this.requestRender() });
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
    // A question that opened by itself reads the composer, so typing in flight and a draft stay there.
    const withComposer = opts?.unprompted ? { ...opts, composerEmpty: () => this.prompt.length === 0 } : opts;
    this.selectionQueue.request({ title, items, opts: withComposer, callback });
  }

  /** Opens the setup form on top of what is open (a place included); resolves when it is submitted or left. */
  public openOnboardingWizard(modeOrOptions: OnboardingWizardMode | OpenOnboardingWizardOptions = 'new'): Promise<OnboardingFormOutcome> {
    // A form kept in the stack from an earlier opening would come back beneath what opened since: it leaves first.
    if (!this.onboardingWizard.active) this.surfaceModals.close(this.modals.onboarding);
    openOnboardingWizardForHandler(this, modeOrOptions);
    return this.onboardingWizard.whenClosed();
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
  public handleDiffApply(): void {
    handleDiffApplyForHandler(this);
  }
  public handleCtrlC(): void {
    handleCtrlCForHandler(this);
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
  ): Promise<void> {
    await completeOpenAiSubscriptionFromListenerForHandler(this, listener, verifier);
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
    try {
      const context = this.feedContext;
      syncFeedContextLiveReferences(this, context);
      // Swap requestRender to buffered version for this feed.
      context.requestRender = bufferedRequestRender;
      context.handleHostPairingToken = (token) => this.hostPairing?.handleToken(token) ?? false;
      const tokens = this.tokenizer.feed(data);
      reportDroppedPaste(this.tokenizer, this.conversationManager, bufferedRequestRender);
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
}
