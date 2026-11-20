import { settleEditorMessageTone } from './agent-workspace-editor-message.ts';
import { openWorkspaceAction, workspaceActionFor } from './workspace-actions.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import type { AgentConfigSetting } from '../config/settings-catalog.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type { CommandContext } from './command-registry.ts';
import { AgentNoteRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/note-registry';
import { AgentPersonaRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/persona-registry';
import { AgentRoutineRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/routine-registry';
import type { AgentRuntimeProfileInfo } from '../agent/runtime-profile.ts';
import { AgentSkillRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry';
import { activateAgentWorkspaceSelection } from './agent-workspace-activation.ts';
import { AGENT_WORKSPACE_CATEGORIES } from './agent-workspace-categories.ts';
import { buildAgentWorkspaceCommandEditorSubmission, isAgentWorkspaceCommandEditorKind } from './agent-workspace-command-editor.ts';
import { createDeleteEditor, editorCategoryId } from './agent-workspace-editors.ts';
import { submitAgentWorkspaceLocalRegistryEditor } from './agent-workspace-local-editor-submission.ts';
import { createAgentWorkspaceLocalSelection, moveAgentWorkspaceLocalLibraryItemSelection, resolveAgentWorkspaceLocalLibrarySelection, selectAgentWorkspaceLocalLibraryItem, selectedAgentWorkspaceLocalLibraryItem, type AgentWorkspaceLocalSelection } from './agent-workspace-local-selection.ts';
import { applyAgentWorkspaceLocalLibraryOperation } from './agent-workspace-local-operations.ts';
import { deleteAgentWorkspaceMemoryEditor, submitAgentWorkspaceMemoryEditor } from './agent-workspace-memory-editor.ts';
import { jumpAgentWorkspaceSelection, moveAgentWorkspaceSelection, selectAgentWorkspaceCategory } from './agent-workspace-navigation.ts';
import { appendAgentWorkspaceActionSearchText, backspaceAgentWorkspaceActionSearch, beginAgentWorkspaceActionSearch, clearAgentWorkspaceActionSearch, commitAgentWorkspaceActionSearchSelection, searchAgentWorkspaceActions } from './agent-workspace-search.ts';
import { applyAgentWorkspaceSetupCheckpointAction } from './agent-workspace-setup-checkpoint-action.ts';
import { agentWorkspaceSettingSchema, agentWorkspaceTuiSettingsImportHasChanges, applyAgentWorkspaceSettingValue, applyAgentWorkspaceTuiSettingsImport, buildAgentWorkspaceSettingActionDisplay, buildAgentWorkspaceSettingActionEffect, createAgentWorkspaceSettingsImportEditor, describeAgentWorkspaceTuiSettingsImportPlan, isAgentWorkspaceActionVisible, planAgentWorkspaceTuiSettingsImport, type AgentWorkspaceSettingActionDisplay, type TuiSettingsImportPlan } from './agent-workspace-settings.ts';
import { isAffirmative } from './agent-workspace-command-editor-engine.ts';
import { workspaceEditorOwnerToolCall, type WorkspaceEditorToolCall } from './agent-workspace-editor-tool-calls.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import { checkAgentWorkspaceHostSetup } from './agent-workspace-setup-host-status.ts';
import { readHostMailboxStatus } from './agent-workspace-host-mailbox.ts';
import { syncAgentWorkspaceLiveCounters } from './agent-workspace-live-counters.ts';
import { trySubmitDirectHostActionEditor } from './agent-workspace-direct-editor-submission.ts';
import { loadHostEmailConnectPrefill, readAgentWorkspaceEmailConnectPrefill, type AgentWorkspaceEmailConnectPrefill } from './agent-workspace-email-connect-editor.ts';
import { submitAgentWorkspaceLocalDeleteEditor, submitAgentWorkspaceMemoryDeleteEditor, type AgentWorkspaceDeleteSubmissionHost } from './agent-workspace-delete-submission.ts';
import type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryGroup, AgentWorkspaceCommandDispatcher, AgentWorkspaceEditorField, AgentWorkspaceFocusPane, AgentWorkspaceLocalEditor, AgentWorkspaceLocalEditorKind, AgentWorkspaceLocalLibraryItem, AgentWorkspaceLocalOperation, AgentWorkspacePromptDispatcher, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
import { ONBOARDING_COMPLETE_SYNTHETIC_ACTION, shouldShowOnboardingFinishFooter } from './agent-workspace-onboarding-finish.ts';
import { completeOnboardingAction, onSubscriptionLoginSuccessAction } from './agent-workspace-onboarding-actions.ts';
import { computeOnboardingStateFromSnapshot, deriveOnboardingEntry, updateRevealedOnboardingCategories } from './agent-workspace-onboarding-state.ts';
import type { OnboardingState } from '../runtime/onboarding/onboarding-state.ts';

export type { AgentWorkspaceChannelRisk, AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
export type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryId, AgentWorkspaceCommandDispatcher, AgentWorkspaceEditorField, AgentWorkspaceFocusPane, AgentWorkspaceLocalEditor, AgentWorkspaceLocalEditorKind, AgentWorkspaceLocalLibraryItem, AgentWorkspaceLocalOperation, AgentWorkspacePromptDispatcher, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
export { AGENT_WORKSPACE_MODAL_NAME } from './agent-workspace-types.ts';
export { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
export { handleAgentWorkspaceToken } from './agent-workspace-token.ts';

const LOCAL_LIBRARY_KINDS: readonly AgentWorkspaceLocalEditorKind[] = ['memory', 'note', 'persona', 'skill', 'routine', 'profile'];

export class AgentWorkspace {
  public active = false;
  public focusPane: AgentWorkspaceFocusPane = 'actions';
  public selectedCategoryIndex = 0;
  public selectedActionIndex = 0;
  public status = 'Ready. Choose an operator flow; ordinary assistant work stays in the main conversation.';
  public runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null = null;
  public lastActionResult: AgentWorkspaceActionResult | null = null;
  private _localEditor: AgentWorkspaceLocalEditor | null = null;
  /** The import plan the open confirm form shows; applying writes exactly this. */
  private pendingSettingsImport: TuiSettingsImportPlan | null = null;
  /**
   * Which open form this is: it changes when the editor closes or a different
   * form opens, not when a field of the open one is edited, so a save that
   * settles later touches only the form it was started from.
   */
  private editorInstance = 0;
  get localEditor(): AgentWorkspaceLocalEditor | null { return this._localEditor; }
  set localEditor(editor: AgentWorkspaceLocalEditor | null) {
    if (editor?.kind !== 'settings-import') this.pendingSettingsImport = null;
    const current = this._localEditor;
    if (editor === null || current === null || editor.kind !== current.kind || editor.mode !== current.mode
      || editor.recordId !== current.recordId || editor.title !== current.title) this.editorInstance += 1;
    this._localEditor = editor ? settleEditorMessageTone(this._localEditor, editor) : null;
  }
  public actionSearchActive = false;
  public actionSearchQuery = '';
  /** Scroll offset into the action-result block, and the result it belongs to. */
  public resultScroll = 0;
  /** Scroll offset into the selected area's context, and the area it belongs to. */
  public workContextScroll = 0;
  public workContextScrollFor: string | null = null;
  public resultScrollFor: AgentWorkspaceActionResult | null = null;
  /** The selected note, memory, skill, routine and persona, held by id. */
  public readonly localSelection: AgentWorkspaceLocalSelection = createAgentWorkspaceLocalSelection();
  private context: CommandContext | null = null;
  private dispatchCommand: AgentWorkspaceCommandDispatcher | null = null;
  private dispatchPrompt: AgentWorkspacePromptDispatcher | null = null;
  private _onlyGroup: AgentWorkspaceCategoryGroup | null = null;
  private _onboardingState: OnboardingState | null = null;
  private _revealedOnboardingCategoryIds = new Set<string>(); // monotonic reveal set
  private _awaitingRecapDismiss = false; // true while showing recap before final close

  open(context: CommandContext, dispatchCommand: AgentWorkspaceCommandDispatcher, categoryId?: string, dispatchPrompt?: AgentWorkspacePromptDispatcher, onlyGroup?: AgentWorkspaceCategoryGroup, requestRender?: () => void): void {
    this.requestRender = requestRender ?? null;
    if (this.context !== context) this.cancelToolCallSubmission();
    this.context?.nativeWorkLedger?.close();
    this.context = context;
    this.workContextScroll = 0;
    context.nativeWorkLedger?.open();
    this.dispatchCommand = dispatchCommand;
    this.dispatchPrompt = dispatchPrompt ?? null;
    this._onlyGroup = onlyGroup ?? null;
    this._awaitingRecapDismiss = false;
    this.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    const shellPaths = context.workspace?.shellPaths;
    this._onboardingState = computeOnboardingStateFromSnapshot(this.runtimeSnapshot, shellPaths);
    if (this._onboardingState) updateRevealedOnboardingCategories(this._onboardingState, this._revealedOnboardingCategoryIds);
    this.active = true;
    this.focusPane = 'actions';
    this.status = 'Ready. Choose an operator flow; ordinary assistant work stays in the main conversation.';
    this.lastActionResult = null;
    this.localEditor = null;
    this.actionSearchActive = false;
    this.actionSearchQuery = '';
    if (!categoryId) {
      this.selectedCategoryIndex = 0;
      this.selectedActionIndex = 0;
    } else if (!this.selectCategory(categoryId)) {
      const normalized = categoryId.trim();
      this.status = `Unknown Agent workspace area: ${normalized}`;
      this.lastActionResult = {
        kind: 'guidance',
        title: 'Unknown Agent workspace area',
        detail: `Use one of ${this.categories.map((category) => category.id).join(', ')}.`,
        safety: 'safe',
      };
    }
    if (onlyGroup === 'ONBOARDING' && this._onboardingState) {
      const entry = deriveOnboardingEntry(this._onboardingState);
      this.status = entry.status;
      if (entry.categoryId) {
        const idx = this.categories.findIndex((c) => c.id === entry.categoryId);
        if (idx >= 0) this.selectedCategoryIndex = idx;
      }
    }
    this.clampSelection();
    // Opened by the shell for a person: take the host reading the setup steps
    // show. A caller with no way to repaint (a model reading the catalogue)
    // has its own asynchronous setup status and does not start one.
    if (this.requestRender) {
      this.readHostSetup(false);
      this.readHostMailbox();
    }
  }

  /**
   * The inbox settings are the connected host's: one reading when the
   * workspace opens, and the snapshot is rebuilt when it lands so the inbox
   * line says what `/email status` says instead of this process's local copy.
   */
  private readHostMailbox(): void {
    const context = this.context;
    const reading = readHostMailboxStatus(context);
    if (!context || !reading) return;
    void reading.then(() => {
      if (this.context !== context || !this.active) return;
      this.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
      this.clampSelection();
      this.requestRender?.();
    });
  }

  private requestRender: (() => void) | null = null;

  /**
   * The setup steps for the connected host read the session's reading of it.
   * The first open takes one bounded reading; when it lands the snapshot is
   * rebuilt so the steps show the answer instead of "checking".
   */
  private readHostSetup(force: boolean): void {
    const context = this.context;
    if (!context) return;
    void checkAgentWorkspaceHostSetup(context, { force }).then(() => {
      if (this.context !== context || !this.active) return;
      this.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
      if (this._onlyGroup === 'ONBOARDING') {
        this._onboardingState = computeOnboardingStateFromSnapshot(this.runtimeSnapshot, context.workspace?.shellPaths);
        if (this._onboardingState) updateRevealedOnboardingCategories(this._onboardingState, this._revealedOnboardingCategoryIds);
      }
      this.clampSelection();
      this.requestRender?.();
    });
  }

  reopen(): void {
    this.context?.nativeWorkLedger?.open();
    this.active = true;
    this.clampSelection();
  }

  close(): void {
    this.cancelToolCallSubmission();
    this.active = false;
    this.context?.nativeWorkLedger?.close();
    this.localEditor = null;
    this.actionSearchActive = false;
    this.actionSearchQuery = '';
    this._onlyGroup = null;
    this._onboardingState = null;
    this._awaitingRecapDismiss = false;
  }

  /** Close the workspace and hand the keyboard back to the composer. */
  closeToComposer(): void {
    if (this.context?.dismissAgentWorkspace?.()) return;
    this.close();
  }

  get nativeWorkLedgerState(): import('../runtime/native-work-ledger.ts').NativeWorkLedgerState {
    this.context?.nativeWorkLedger?.sync();
    return this.context?.nativeWorkLedger?.state ?? { status: 'unavailable', reason: 'No authenticated daemon work ledger binding is installed.' };
  }

  get categories(): readonly AgentWorkspaceCategory[] {
    if (this._onlyGroup === 'ONBOARDING') {
      // Pure read, reveal set is updated at every _onboardingState assignment
      // (open, onSubscriptionLoginSuccess), not here. Recompute is O(categories)
      // and intentionally simple; the list is small and no caching is needed.
      const onboarding = AGENT_WORKSPACE_CATEGORIES.filter((c) => c.group === 'ONBOARDING');
      if (this._onboardingState) {
        return onboarding.filter((c) => this._revealedOnboardingCategoryIds.has(c.id));
      }
      return onboarding;
    }
    if (this._onlyGroup) {
      return AGENT_WORKSPACE_CATEGORIES.filter((category) => category.group === this._onlyGroup);
    }
    return AGENT_WORKSPACE_CATEGORIES;
  }

  get selectedCategory(): AgentWorkspaceCategory {
    return this.categories[this.selectedCategoryIndex] ?? this.categories[0]!;
  }

  get actions(): readonly AgentWorkspaceAction[] {
    if (this.actionSearchActive) return this.actionSearchResults.map((result) => result.action);
    const base = this.selectedCategory.actions.filter((action) => isAgentWorkspaceActionVisible(this.context, action));
    if (shouldShowOnboardingFinishFooter(this.selectedCategory, base, this._onlyGroup === 'ONBOARDING' ? this._onboardingState?.readyToChat : undefined)) {
      return [...base, ONBOARDING_COMPLETE_SYNTHETIC_ACTION];
    }
    return base;
  }

  get selectedAction(): AgentWorkspaceAction | null {
    return this.actions[this.selectedActionIndex] ?? null;
  }

  get selectedActionCategory(): AgentWorkspaceCategory {
    if (this.actionSearchActive) return this.selectedActionSearchResult?.category ?? this.selectedCategory;
    return this.selectedCategory;
  }

  get actionSearchResults(): readonly AgentWorkspaceActionSearchResult[] {
    if (!this.actionSearchActive) return [];
    const categories = this.categories.map((category) => ({
      ...category,
      actions: category.actions.filter((action) => isAgentWorkspaceActionVisible(this.context, action)),
    }));
    return searchAgentWorkspaceActions(categories, this.actionSearchQuery);
  }

  get selectedActionSearchResult(): AgentWorkspaceActionSearchResult | null {
    if (!this.actionSearchActive) return null;
    return this.actionSearchResults[this.selectedActionIndex] ?? null;
  }

  selectCategory(categoryIdOrLabel: string): boolean {
    return selectAgentWorkspaceCategory(this, categoryIdOrLabel);
  }

  cycleCategory(direction: 'next' | 'prev'): void {
    const total = this.categories.length;
    if (total === 0) return;
    const delta = direction === 'next' ? 1 : -1;
    this.selectedCategoryIndex = (this.selectedCategoryIndex + delta + total) % total;
    this.selectedActionIndex = 0;
    this.focusPane = 'actions';
    this.clampSelection();
    this.status = `Agent workspace category: ${this.selectedCategory.label}.`;
    this.lastActionResult = null;
  }

  selectedLocalLibraryItem(kind: AgentWorkspaceLocalEditorKind): AgentWorkspaceLocalLibraryItem | null {
    return selectedAgentWorkspaceLocalLibraryItem(this.runtimeSnapshot, this.localSelection, kind);
  }

  settingActionDisplay(action: AgentWorkspaceAction): AgentWorkspaceSettingActionDisplay | null {
    return buildAgentWorkspaceSettingActionDisplay(this.context, action);
  }

  focusCategories(): void {
    this.focusPane = 'categories';
  }

  focusActions(): void {
    this.focusPane = 'actions';
  }

  toggleFocusPane(): void {
    this.focusPane = this.focusPane === 'categories' ? 'actions' : 'categories';
  }

  /** Scroll the action-result block; the renderer clamps and resets it. */
  scrollActionResult(delta: number): void {
    this.resultScroll = Math.max(0, this.resultScroll + delta);
  }

  moveUp(): void { moveAgentWorkspaceSelection(this, -1); }
  moveDown(): void { moveAgentWorkspaceSelection(this, 1); }
  jumpHome(): void { jumpAgentWorkspaceSelection(this, 'home'); }
  jumpEnd(): void { jumpAgentWorkspaceSelection(this, 'end'); }

  refreshRuntimeSnapshot(): void {
    if (this.selectedActionCategory.id === 'work') this.context?.nativeWorkLedger?.open();
    if (!this.context) {
      this.status = 'Runtime context is unavailable.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Context refresh failed',
        detail: 'The Agent workspace has no command context to inspect.',
      };
      return;
    }
    this.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(this.context);
    this.readHostSetup(true);
    this.status = 'Runtime context refreshed; checking the connected host again.';
    this.lastActionResult = { kind: 'refreshed', title: 'Runtime context refreshed', detail: 'Provider, model, session, local memory, runtime endpoint, and Agent knowledge route posture were re-read from the live command context. The connected host is being checked again; its setup steps update when it answers.' };
  }

  /** Render-path live counter mirror (see syncAgentWorkspaceLiveCounters). */ syncLiveCountersForRender(): void { syncAgentWorkspaceLiveCounters({ context: this.context, runtimeSnapshot: this.runtimeSnapshot, setRuntimeSnapshot: (snapshot) => { this.runtimeSnapshot = snapshot; }, clampSelection: () => this.clampSelection() }); }

  cancelLocalEditor(): void {
    if (!this.localEditor) return;
    if (this.toolCallSubmission?.editorKind === this.localEditor.kind) {
      // Esc on a form whose tool call is still running stops that call.
      this.cancelToolCallSubmission();
      this.localEditor = null;
      return;
    }
    const title = this.localEditor.title;
    if (this.memorySaveInFlight && this.memorySaveEditor === this.editorInstance) {
      // The save is already running and cannot be taken back: the form closes,
      // and the save's own result is shown when it settles.
      this.localEditor = null;
      this.status = `${title}: saving; the result will be shown when it finishes.`;
      this.lastActionResult = {
        kind: 'guidance',
        title: `${title}: saving`,
        detail: 'The form was closed while its save was running. The save was not stopped; whether it was written is shown here when it finishes.',
      };
      return;
    }
    this.localEditor = null;
    this.status = `${title} cancelled.`;
    this.lastActionResult = {
      kind: 'guidance',
      title: `${title} cancelled`,
      detail: 'No Agent-local registry changes were written.',
    };
  }

  beginActionSearch(): void {
    beginAgentWorkspaceActionSearch(this);
  }

  appendActionSearchText(text: string): void {
    appendAgentWorkspaceActionSearchText(this, text);
  }

  actionSearchBackspace(): void {
    backspaceAgentWorkspaceActionSearch(this);
  }

  clearActionSearch(): void {
    clearAgentWorkspaceActionSearch(this);
  }

  commitActionSearchSelection(): boolean {
    return commitAgentWorkspaceActionSearchSelection(this, this.selectedActionSearchResult);
  }

  moveEditorField(delta: number): void {
    const editor = this.localEditor;
    if (!editor) return;
    const nextIndex = Math.max(0, Math.min(editor.fields.length - 1, editor.selectedFieldIndex + delta));
    this.localEditor = { ...editor, selectedFieldIndex: nextIndex };
  }

  appendEditorText(text: string): void {
    const editor = this.localEditor;
    if (!editor || text.length === 0) return;
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field) return;
    this.replaceEditorField(editor.selectedFieldIndex, `${field.value}${field.multiline ? text.replace(/\r\n?/g, '\n') : text.replace(/[\r\n]+/g, ' ')}`, editor.message);
  }

  appendEditorNewline(): void {
    const editor = this.localEditor;
    if (!editor) return;
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field || !field.multiline) {
      this.moveEditorField(1);
      return;
    }
    this.replaceEditorField(editor.selectedFieldIndex, `${field.value}\n`, editor.message);
  }

  editorBackspace(): void {
    const editor = this.localEditor;
    if (!editor) return;
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field || field.value.length === 0) return;
    const characters = Array.from(field.value);
    characters.pop();
    this.replaceEditorField(editor.selectedFieldIndex, characters.join(''), editor.message);
  }

  submitEditorFieldOrForm(requestRender?: () => void): void {
    const editor = this.localEditor;
    if (!editor) return;
    if (editor.selectedFieldIndex < editor.fields.length - 1) {
      this.moveEditorField(1);
      return;
    }
    this.submitLocalEditor(requestRender);
  }

  activateSelected(requestRender?: () => void): void {
    activateAgentWorkspaceSelection(this, requestRender);
  }

  openGuidedAction(editorKind: string): boolean {
    const target = workspaceActionFor(editorKind);
    const context = this.context;
    if (!target || !context?.openSelection) return false;
    this.closeToComposer();
    return openWorkspaceAction(target, context);
  }

  hasCommandDispatch(): boolean {
    return Boolean(this.context?.executeCommand && this.dispatchCommand);
  }

  hasPromptDispatch(): boolean {
    // A workspace prompt is sent as written (submitTurn), never read as composer input.
    return Boolean(this.context?.submitTurn && this.dispatchPrompt);
  }

  dispatchWorkspaceCommand(command: string, behavior?: 'inline' | 'compose' | 'exit', displayCommand?: string): void {
    this.dispatchCommand?.(command, behavior, displayCommand);
  }

  emailConnectPrefill(): AgentWorkspaceEmailConnectPrefill | null {
    return readAgentWorkspaceEmailConnectPrefill(this.context);
  }

  loadEmailConnectPrefillFromHost(): Promise<AgentWorkspaceEmailConnectPrefill | null> | null {
    return loadHostEmailConnectPrefill(this.context);
  }

  dispatchWorkspacePrompt(prompt: string): void {
    this.dispatchPrompt?.(prompt);
  }

  clampSelection(): void {
    this.selectedCategoryIndex = Math.max(0, Math.min(this.selectedCategoryIndex, this.categories.length - 1));
    this.selectedActionIndex = Math.max(0, Math.min(this.selectedActionIndex, this.actions.length - 1));
    for (const kind of LOCAL_LIBRARY_KINDS) resolveAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.localSelection, kind);
  }

  moveLocalLibraryItemSelection(kind: AgentWorkspaceLocalEditorKind, delta: number): void {
    moveAgentWorkspaceLocalLibraryItemSelection(this, kind, delta);
  }

  applyLocalLibraryOperation(operation: AgentWorkspaceLocalOperation): void {
    applyAgentWorkspaceLocalLibraryOperation(this, operation, {
      shellPaths: () => this.context?.workspace?.shellPaths,
      selectedItemForOperation: (selectedOperation) => this.selectedItemForOperation(selectedOperation),
      memoryApi: () => this.memoryApi(),
      finishLocalOperation: (kind, title, detail) => this.finishLocalOperation(kind, title, detail),
      openDeleteEditor: (kind, selected) => this.openDeleteEditor(kind, selected),
    });
  }

  completeOnboarding(): void {
    const result = completeOnboardingAction({
      awaitingRecapDismiss: this._awaitingRecapDismiss,
      runtimeSnapshot: this.runtimeSnapshot,
      shellPaths: this.context?.workspace?.shellPaths,
      dismissAgentWorkspace: this.context?.dismissAgentWorkspace,
      close: () => this.close(),
    });
    if (result.dismissed) return;
    this._awaitingRecapDismiss = result.awaitingRecapDismiss;
    this.status = result.status;
    this.lastActionResult = result.lastActionResult;
  }

  onSubscriptionLoginSuccess(): void {
    const result = onSubscriptionLoginSuccessAction({
      onlyGroup: this._onlyGroup,
      runtimeSnapshot: this.runtimeSnapshot,
      shellPaths: this.context?.workspace?.shellPaths,
    });
    if (this._onlyGroup !== 'ONBOARDING') return;
    // Update _onboardingState and reveal set FIRST so that this.categories
    // reflects any newly-unlocked lane (e.g. account-model after sign-in)
    // before we try to resolve the target index against the fresh list.
    this._onboardingState = result.onboardingState;
    if (!result.onboardingState) return;
    if (this._onboardingState) updateRevealedOnboardingCategories(this._onboardingState, this._revealedOnboardingCategoryIds);
    if (result.targetCategoryId) {
      const idx = this.categories.findIndex((c) => c.id === result.targetCategoryId);
      if (idx >= 0) this.selectedCategoryIndex = idx;
    }
    this.status = result.status;
  }

  openModelPickerAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    const target = action.modelPickerTarget ?? 'main';
    const opened = action.modelPickerFlow === 'model'
      ? this.context?.openModelPickerWithTarget?.(target)
      : this.context?.openProviderModelPickerWithTarget?.(target);
    if (!opened) {
      this.status = 'Model picker is unavailable.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Model picker unavailable',
        detail: 'This runtime cannot open the model picker from Agent workspace.',
        safety: action.safety,
      };
      requestRender?.();
      return;
    }
    this.status = `Opening ${action.label}.`;
    this.lastActionResult = {
      kind: 'dispatched',
      title: `Opening ${action.label}`,
      detail: 'Opened the shared provider/model picker for this setup target.',
      safety: action.safety,
    };
    requestRender?.();
  }

  openSettingsModalAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    if (!this.context?.openSettingsModal) {
      this.status = 'Settings are unavailable.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Settings unavailable',
        detail: 'This runtime cannot open settings from Agent workspace.',
        safety: action.safety,
      };
      requestRender?.();
      return;
    }
    this.context.openSettingsModal(action.settingsTarget);
    this.status = `Opening ${action.label}.`;
    this.lastActionResult = {
      kind: 'dispatched',
      title: `Opening ${action.label}`,
      detail: 'Opened the shared settings surface for this setup area.',
      safety: action.safety,
    };
    requestRender?.();
  }

  applySettingAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    const effect = buildAgentWorkspaceSettingActionEffect(this.context, action);
    if (effect.kind === 'result') {
      this.status = effect.status;
      this.lastActionResult = effect.result;
      return;
    }
    if (effect.kind === 'editor') {
      this.localEditor = effect.editor;
      this.status = effect.status;
      this.lastActionResult = effect.result;
      return;
    }
    void this.applySettingValue(effect.setting, effect.value, requestRender);
  }

  /**
   * The import row reads the sources once into a plan and shows it; nothing is
   * written until the owner confirms the form, and then exactly that plan is.
   */
  importTuiSettings(requestRender?: () => void): void {
    const plan = planAgentWorkspaceTuiSettingsImport(this.context);
    if (!plan || !agentWorkspaceTuiSettingsImportHasChanges(plan)) {
      void this.applyTuiSettingsImport(plan, requestRender);
      return;
    }
    const editor = createAgentWorkspaceSettingsImportEditor(plan);
    this.localEditor = editor;
    this.pendingSettingsImport = plan;
    this.status = 'Review the GoodVibes settings import, then type yes to apply it.';
    this.lastActionResult = {
      kind: 'guidance',
      title: 'GoodVibes settings import: what would change',
      detail: describeAgentWorkspaceTuiSettingsImportPlan(plan),
      safety: 'safe',
    };
  }

  applySetupCheckpointAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    applyAgentWorkspaceSetupCheckpointAction({
      context: this.context,
      runtimeSnapshot: this.runtimeSnapshot,
      setRuntimeSnapshot: (snapshot) => {
        this.runtimeSnapshot = snapshot;
      },
      setStatus: (status) => {
        this.status = status;
      },
      setLastActionResult: (result) => {
        this.lastActionResult = result;
      },
      clampSelection: () => this.clampSelection(),
    }, action, requestRender);
  }

  private selectedItemForOperation(operation: AgentWorkspaceLocalOperation): AgentWorkspaceLocalLibraryItem | null {
    if (operation.startsWith('memory-')) return this.selectedLocalLibraryItem('memory');
    if (operation.startsWith('note-')) return this.selectedLocalLibraryItem('note');
    if (operation.startsWith('persona-')) return this.selectedLocalLibraryItem('persona');
    if (operation.startsWith('skill-')) return this.selectedLocalLibraryItem('skill');
    return this.selectedLocalLibraryItem('routine');
  }

  private async applySettingValue(setting: AgentConfigSetting, value: unknown, requestRender?: () => void): Promise<void> {
    const outcome = await applyAgentWorkspaceSettingValue(this.context, setting, value);
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    this.clampSelection();
    this.status = outcome.status;
    this.lastActionResult = outcome.result;
    requestRender?.();
  }

  private async applyTuiSettingsImport(plan: TuiSettingsImportPlan | null, requestRender?: () => void): Promise<void> {
    let outcome: Awaited<ReturnType<typeof applyAgentWorkspaceTuiSettingsImport>>;
    try {
      outcome = await applyAgentWorkspaceTuiSettingsImport(this.context, plan);
    } catch (error) {
      // Started with `void` after the form closed: a throw would otherwise leave the
      // status on the review prompt with no word of what was or was not imported.
      const reason = error instanceof Error ? error.message : String(error);
      this.status = `GoodVibes settings import stopped: ${reason}`;
      this.lastActionResult = {
        kind: 'error',
        title: 'Import stopped',
        detail: `The import stopped part-way: ${reason}. Some settings may already have changed; open Settings to check them, and the undo file beside the Agent's state holds their previous values.`,
        safety: 'safe',
      };
      requestRender?.();
      return;
    }
    this.runtimeSnapshot = outcome.runtimeSnapshot ?? this.runtimeSnapshot;
    this.clampSelection();
    this.status = outcome.status;
    this.lastActionResult = outcome.result;
    requestRender?.();
  }

  private memoryApi(): MemoryApi {
    const memory = this.context?.clients?.agentKnowledgeApi?.memory;
    if (!memory) throw new Error('Agent Memory API is unavailable; refusing default knowledge or non-Agent fallback.');
    return memory;
  }

  private learnedBehaviorTarget(): Exclude<AgentWorkspaceLocalEditorKind, 'memory' | 'note' | 'profile'> {
    const target = this.editorField('target').trim().toLowerCase();
    if (target === 'persona' || target === 'skill' || target === 'routine') return target;
    throw new Error('Behavior type must be skill, routine, or persona.');
  }

  private finishLocalOperation(kind: AgentWorkspaceLocalEditorKind, title: string, detail: string): void {
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    resolveAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.localSelection, kind);
    this.status = title;
    this.lastActionResult = {
      kind: 'refreshed',
      title,
      detail,
      safety: 'safe',
    };
  }

  private openDeleteEditor(kind: AgentWorkspaceLocalEditorKind, selected: AgentWorkspaceLocalLibraryItem): void {
    this.localEditor = createDeleteEditor(kind, selected);
    this.status = `Confirm deletion for ${selected.name}.`;
    this.lastActionResult = {
      kind: 'guidance',
      title: this.localEditor.title,
      detail: this.localEditor.message,
      safety: 'safe',
    };
  }

  private replaceEditorField(index: number, value: string, message: string): void {
    const editor = this.localEditor;
    if (!editor) return;
    const fields = editor.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, value } : field);
    this.localEditor = { ...editor, fields, message };
  }

  private editorField(id: string): string {
    const editor = this.localEditor;
    const field = editor?.fields.find((candidate) => candidate.id === id);
    if (!field) return '';
    return field.verbatim ? field.value : field.value.trim();
  }

  private missingEditorField(): AgentWorkspaceEditorField | null {
    const editor = this.localEditor;
    if (!editor) return null;
    return editor.fields.find((field) => field.required && (field.verbatim ? field.value.length === 0 : field.value.trim().length === 0)) ?? null;
  }

  private submitLocalEditor(requestRender?: () => void): void {
    const editor = this.localEditor;
    if (!editor) return;
    const missing = this.missingEditorField();
    if (missing) {
      const missingIndex = editor.fields.findIndex((field) => field.id === missing.id);
      this.localEditor = {
        ...editor,
        selectedFieldIndex: Math.max(0, missingIndex),
        message: `${missing.label} is required before saving.`,
      };
      this.status = `${missing.label} is required.`;
      return;
    }
    if (editor.kind === 'settings-import') {
      const plan = this.pendingSettingsImport;
      if (!isAffirmative(this.editorField('confirm')) || !plan) {
        this.localEditor = { ...editor, message: plan ? 'Not applied. Type yes, then press Enter, or Esc to leave everything as it is.' : 'This import is no longer open; choose Import GoodVibes settings again.' };
        this.status = 'GoodVibes settings import not confirmed.';
        return;
      }
      this.localEditor = null;
      void this.applyTuiSettingsImport(plan, requestRender);
      return;
    }
    if (trySubmitDirectHostActionEditor(this, editor, this.context, (id) => this.editorField(id), requestRender)) return;
    // A form whose work is one tool call runs that call now, as the owner's
    // confirmed action: no chat turn, and the values are exactly the ones typed.
    const toolCall = workspaceEditorOwnerToolCall(editor);
    if (toolCall) {
      void this.submitToolCallEditor(editor, toolCall, requestRender);
      return;
    }
    if (isAgentWorkspaceCommandEditorKind(editor.kind)) {
      this.submitCommandEditor(editor);
      requestRender?.();
      return;
    }
    if (editor.kind === 'setting-set') {
      const setting = editor.recordId ? agentWorkspaceSettingSchema(this.context, editor.recordId) : null;
      if (!setting) {
        this.localEditor = { ...editor, message: 'Unknown setting; cannot save.' };
        this.status = 'Unknown setting; cannot save.';
        requestRender?.();
        return;
      }
      const value = this.editorField('value');
      this.localEditor = null;
      void this.applySettingValue(setting, value, requestRender);
      return;
    }
    if (editor.kind === 'memory') {
      if (editor.mode === 'delete') {
        try {
          this.submitMemoryDeleteEditor(editor);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.localEditor = { ...editor, message: detail };
          this.status = detail;
          this.lastActionResult = {
            kind: 'error',
            title: `${editor.title} failed`,
            detail,
          };
        }
        requestRender?.();
        return;
      }
      // The editor stays open while the save is awaited, so a second Enter would add a second record.
      if (this.memorySaveInFlight) {
        this.status = 'Not saved again: the first save of this memory is still running; its result appears here when it finishes.';
        requestRender?.();
        return;
      }
      this.memorySaveInFlight = true;
      void this.submitMemoryEditor(editor).finally(() => {
        this.memorySaveInFlight = false;
        requestRender?.();
      });
      return;
    }
    const shellPaths = this.context?.workspace?.shellPaths;
    if (!shellPaths) {
      this.localEditor = { ...editor, message: 'Cannot save because Agent shell paths are unavailable.' };
      this.status = 'Cannot save Agent-local registry item without shell paths.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Local registry unavailable',
        detail: 'The Agent workspace cannot locate the Agent-local registry files for this runtime.',
      };
      return;
    }
    try {
      submitAgentWorkspaceLocalRegistryEditor(shellPaths, editor, {
        readField: (id) => this.editorField(id),
        learnedBehaviorTarget: () => this.learnedBehaviorTarget(),
        submitDeleteEditor: () => this.submitLocalDeleteEditor(shellPaths, editor),
        finishLocalEditor: (kind, id, name, verb) => this.finishLocalEditor(kind, id, name, verb),
        finishProfileEditor: (profile) => this.finishProfileEditor(profile),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.localEditor = { ...editor, message: detail };
      this.status = detail;
      this.lastActionResult = {
        kind: 'error',
        title: `${editor.title} failed`,
        detail,
      };
    }
  }

  /** The one tool call a workspace form is running, so Esc or closing the workspace can stop it. */
  private toolCallSubmission: { readonly controller: AbortController; readonly title: string; readonly editorKind: AgentWorkspaceLocalEditor['kind'] } | null = null;

  /** Stops the running form's tool call, if there is one, and says so. */
  private cancelToolCallSubmission(): void {
    const running = this.toolCallSubmission;
    if (!running) return;
    this.toolCallSubmission = null;
    running.controller.abort();
    this.status = `Cancelled ${running.title}; nothing further was run.`;
    this.lastActionResult = {
      kind: 'guidance',
      title: `${running.title} cancelled`,
      detail: `The running ${running.title} call was stopped. Anything it finished before the stop stays done; nothing further was run.`,
    };
  }

  /**
   * Runs the one tool call a form stands for (the same call the agent's
   * run_workspace_action makes from the same fields) through the registry's
   * owner-confirmed entry: the owner's yes is the approval, a deny rule or plan
   * mode still refuses, and the tool's own answer is shown here.
   */
  private async submitToolCallEditor(editor: AgentWorkspaceLocalEditor, toolCall: WorkspaceEditorToolCall, requestRender?: () => void): Promise<void> {
    if (this.toolCallSubmission) {
      this.status = `Not run again: ${editor.title} is still running; its result appears here when it finishes.`;
      requestRender?.();
      return;
    }
    if (toolCall.confirmation && !isAffirmative(this.editorField('confirm'))) {
      this.localEditor = { ...editor, message: 'Nothing was run. Type yes in Confirm, then press Enter.' };
      this.status = `${editor.title} not confirmed.`;
      requestRender?.();
      return;
    }
    const context = this.context;
    const registry = context?.extensions?.toolRegistry;
    if (!context || !registry || typeof registry.executeOwnerConfirmed !== 'function') {
      this.localEditor = { ...editor, message: `Nothing was run: this runtime has no tool registry to run ${toolCall.tool}.` };
      this.status = `${editor.title} unavailable.`;
      this.lastActionResult = { kind: 'error', title: `${editor.title} unavailable`, detail: `This runtime has no tool registry, so ${toolCall.tool} cannot run from the workspace.` };
      requestRender?.();
      return;
    }
    const request = `The owner filled in the workspace form "${editor.title}" and confirmed it.`;
    const args = { ...toolCall.build((fieldId) => this.editorField(fieldId), request) } as Record<string, unknown>;
    const controller = new AbortController();
    this.toolCallSubmission = { controller, title: editor.title, editorKind: editor.kind };
    this.status = `Running ${editor.title}...`;
    requestRender?.();
    let result: { readonly success: boolean; readonly output?: string | undefined; readonly error?: string | undefined };
    try {
      result = await registry.executeOwnerConfirmed(`workspace-${toolCall.callId}`, toolCall.tool, args, {
        goal: request,
        criteria: [`Run ${toolCall.tool} with exactly the values the owner entered in "${editor.title}".`],
        signal: controller.signal,
      });
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.toolCallSubmission?.controller === controller) this.toolCallSubmission = null;
    }
    // Cancelled from here (Esc, closing the workspace): the cancellation already said so.
    if (controller.signal.aborted) {
      requestRender?.();
      return;
    }
    // The person may have closed the workspace or moved to another form meanwhile.
    if (this.context !== context) return;
    if (!result.success) {
      const detail = result.error ?? `${toolCall.tool} did not succeed and gave no reason.`;
      if (this.localEditor?.kind === editor.kind) this.localEditor = { ...this.localEditor, message: `Not done: ${detail}` };
      this.status = `${editor.title} was not done.`;
      this.lastActionResult = { kind: 'error', title: `${editor.title} was not done`, detail, command: toolCall.tool };
      requestRender?.();
      return;
    }
    if (this.localEditor?.kind === editor.kind) this.localEditor = null;
    this.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    this.status = `${editor.title}: done.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: `${editor.title}: done`,
      detail: result.output?.trim() || `${toolCall.tool} finished with no output.`,
      command: toolCall.tool,
      safety: toolCall.confirmation ? 'safe' : 'read-only',
    };
    requestRender?.();
  }

  private submitCommandEditor(editor: AgentWorkspaceLocalEditor): void {
    const result = buildAgentWorkspaceCommandEditorSubmission(editor, (fieldId) => this.editorField(fieldId), this.hasCommandDispatch(), this.hasPromptDispatch());
    if (result.kind === 'editor') {
      this.localEditor = result.editor;
      this.status = result.status;
      if (result.actionResult) this.lastActionResult = result.actionResult;
      return;
    }

    this.localEditor = null;
    this.status = result.status;
    this.lastActionResult = result.actionResult;
    if (result.kind === 'prompt') {
      this.dispatchWorkspacePrompt(result.prompt);
      return;
    }
    this.dispatchWorkspaceCommand(result.command, undefined, result.actionResult.command);
  }

  private submitLocalDeleteEditor(shellPaths: ShellPathService, editor: AgentWorkspaceLocalEditor): void {
    submitAgentWorkspaceLocalDeleteEditor(this.deleteHost(), shellPaths, editor);
  }

  private submitMemoryDeleteEditor(editor: AgentWorkspaceLocalEditor): void {
    submitAgentWorkspaceMemoryDeleteEditor(this.deleteHost(), editor);
  }

  /**
   * The narrow surface the delete submitters need. The accessors write straight
   * back to this workspace, so an extracted submitter still refuses and reports
   * exactly where the inline one did.
   */
  private deleteHost(): AgentWorkspaceDeleteSubmissionHost {
    const workspace = this;
    return {
      get localEditor() { return workspace.localEditor; },
      set localEditor(value: AgentWorkspaceLocalEditor | null) { workspace.localEditor = value; },
      get status() { return workspace.status; },
      set status(value: string) { workspace.status = value; },
      editorField: (id) => workspace.editorField(id),
      memoryApi: () => workspace.memoryApi(),
      finishLocalDelete: (kind, id, name) => { workspace.finishLocalDelete(kind, id, name); },
    };
  }
  private memorySaveInFlight = false;
  /** The form instance whose memory save is running. */
  private memorySaveEditor = -1;
  private async submitMemoryEditor(editor: AgentWorkspaceLocalEditor): Promise<void> {
    const instance = this.editorInstance;
    this.memorySaveEditor = instance;
    try {
      this.status = 'Saving Agent memory...';
      const result = await submitAgentWorkspaceMemoryEditor(editor, this.memoryApi(), (id) => this.editorField(id));
      this.finishMemoryEditor(result.record, result.verb, instance);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // The form is reopened with the reason only when it is still the one
      // shown; a form opened since is never replaced by this one.
      if (this.editorInstance === instance && this.localEditor !== null) this.localEditor = { ...editor, message: detail };
      this.status = detail;
      this.lastActionResult = {
        kind: 'error',
        title: `${editor.title} failed`,
        detail,
      };
    }
  }

  private finishMemoryEditor(record: MemoryRecord, verb: 'Created' | 'Updated', instance: number): void {
    // Only the form this save started from closes; one opened since stays open.
    const stillShown = this.editorInstance === instance && this.localEditor !== null;
    if (stillShown) this.localEditor = null;
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    const categoryIndex = this.localEditor === null ? this.categories.findIndex((category) => category.id === 'memory') : -1;
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = 0;
    }
    this.status = `${verb} memory ${record.summary}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: `${verb} memory`,
      detail: `${record.summary} (${record.id}) was saved to Agent-owned memory only.`,
      safety: 'safe',
    };
    selectAgentWorkspaceLocalLibraryItem(this.runtimeSnapshot, this.localSelection, 'memory', record.id);
    this.clampSelection();
  }

  private finishLocalEditor(kind: AgentWorkspaceLocalEditorKind, id: string, name: string, verb: 'Created' | 'Updated'): void {
    this.localEditor = null;
    const categoryId = editorCategoryId(kind);
    const categoryIndex = this.categories.findIndex((category) => category.id === categoryId);
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = 0;
    }
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    this.status = `${verb} ${kind} ${name}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: `${verb} ${kind}`,
      detail: `${name} (${id}) was saved to the Agent-local ${categoryId} registry.`,
      safety: 'safe',
    };
    selectAgentWorkspaceLocalLibraryItem(this.runtimeSnapshot, this.localSelection, kind, id);
    this.clampSelection();
  }

  private finishProfileEditor(profile: AgentRuntimeProfileInfo): void {
    this.localEditor = null;
    const categoryIndex = this.categories.findIndex((category) => category.id === 'profiles');
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = this.categories[categoryIndex]?.actions.findIndex((action) => action.id === 'runtime-profile-create') ?? 0;
      if (this.selectedActionIndex < 0) this.selectedActionIndex = 0;
    }
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    const starter = profile.starterTemplateId ? ` from ${profile.starterTemplateId}` : '';
    this.status = `Created Agent profile ${profile.id}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: 'Created Agent profile',
      detail: `Created isolated Agent profile ${profile.id}${starter}. Launch it with goodvibes-agent --agent-profile ${profile.id}. The current Agent session was not switched.`,
      safety: 'safe',
    };
    this.clampSelection();
  }

  private finishLocalDelete(kind: AgentWorkspaceLocalEditorKind, id: string, name: string): void {
    this.localEditor = null;
    const categoryId = editorCategoryId(kind);
    const categoryIndex = this.categories.findIndex((category) => category.id === categoryId);
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = 0;
    }
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    this.status = `Deleted ${kind} ${name}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: `Deleted ${kind}`,
      detail: `${name} (${id}) was removed from the Agent-local ${categoryId} registry.`,
      safety: 'safe',
    };
    this.clampSelection();
  }
}
