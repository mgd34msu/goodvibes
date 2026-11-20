import { openWorkspaceAction, type WorkspaceActionTarget } from './workspace-actions.ts';
import { describedCommandByName, isCommandReport, renderCommandReport, type ActionDescription } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import { captureCommandPrint } from './workspace-command-output.ts';
import type { AgentConfigSetting } from '../config/settings-catalog.ts';
import type { CommandContext } from './command-registry.ts';
import { activateAgentWorkspaceSelection } from './agent-workspace-activation.ts';
import { AGENT_WORKSPACE_CATEGORIES } from './agent-workspace-categories.ts';
import { jumpAgentWorkspaceSelection, moveAgentWorkspaceSelection, selectAgentWorkspaceCategory } from './agent-workspace-navigation.ts';
import { appendAgentWorkspaceActionSearchText, backspaceAgentWorkspaceActionSearch, beginAgentWorkspaceActionSearch, clearAgentWorkspaceActionSearch, commitAgentWorkspaceActionSearchSelection, searchAgentWorkspaceActions } from './agent-workspace-search.ts';
import { agentWorkspaceTuiSettingsImportHasChanges, applyAgentWorkspaceSettingValue, applyAgentWorkspaceTuiSettingsImport, buildAgentWorkspaceSettingActionDisplay, buildAgentWorkspaceSettingActionEffect, describeAgentWorkspaceTuiSettingsImportPlan, readAgentWorkspaceSettingFacts, type AgentWorkspaceSettingFacts, isAgentWorkspaceActionVisible, planAgentWorkspaceTuiSettingsImport, type AgentWorkspaceSettingActionDisplay, type TuiSettingsImportPlan } from './agent-workspace-settings.ts';
import { buildAgentWorkspaceSetupPart } from './agent-workspace-snapshot.ts';
import { checkAgentWorkspaceHostSetup } from './agent-workspace-setup-host-status.ts';
import type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryGroup, AgentWorkspaceCommandDispatcher, AgentWorkspaceFocusPane, AgentWorkspaceSetupPart } from './agent-workspace-types.ts';
import { ONBOARDING_COMPLETE_SYNTHETIC_ACTION, shouldShowOnboardingFinishFooter } from './agent-workspace-onboarding-finish.ts';
import { completeOnboardingAction, onSubscriptionLoginSuccessAction } from './agent-workspace-onboarding-actions.ts';
import { computeOnboardingStateFromSnapshot, deriveOnboardingEntry, updateRevealedOnboardingCategories } from './agent-workspace-onboarding-state.ts';
import type { OnboardingState } from '../runtime/onboarding/onboarding-state.ts';

export type { AgentWorkspaceChannelRisk, AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
export type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryId, AgentWorkspaceCommandDispatcher, AgentWorkspaceFocusPane, AgentWorkspaceLocalLibraryItem, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
export { AGENT_WORKSPACE_MODAL_NAME } from './agent-workspace-types.ts';
export { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
export { handleAgentWorkspaceToken } from './agent-workspace-token.ts';

/** A command's short report as the pane shows it: null lines while it is being read. */
export interface CommandReportReading {
  readonly command: string;
  /** The line that prints it. */
  readonly line: string;
  /** The report action's own name. */
  readonly label: string;
  readonly lines: readonly string[] | null;
  /** The report reaches past this machine (a mailbox, a host, a provider): not run until Ctrl+R asks for it. */
  readonly waiting?: true;
}

export class AgentWorkspace {
  public active = false;
  public focusPane: AgentWorkspaceFocusPane = 'actions';
  public selectedCategoryIndex = 0;
  public selectedActionIndex = 0;
  public status = 'Ready. Choose an operator flow; ordinary assistant work stays in the main conversation.';
  /** Only the setup part: the workspace reads its setup steps and onboarding route, nothing else of the snapshot. */
  public runtimeSnapshot: AgentWorkspaceSetupPart | null = null;
  public lastActionResult: AgentWorkspaceActionResult | null = null;
  public actionSearchActive = false;
  public actionSearchQuery = '';
  /** Scroll offset into the action-result block, and the result it belongs to. */
  public resultScroll = 0;
  /** Scroll offset into the selected area's context, and the area it belongs to. */
  public workContextScroll = 0;
  public workContextScrollFor: string | null = null;
  /** How many pane rows one PgUp/PgDn moves: as many as the pane shows (set when it is drawn). */
  public contextPageRows = 5;
  public resultScrollFor: AgentWorkspaceActionResult | null = null;
  private context: CommandContext | null = null;
  /** Each command's short report, read once per opening when one of its rows is first selected. */
  private readonly reports = new Map<string, CommandReportReading>();
  /** Reports the owner asked for with Ctrl+R in this opening, run even though they reach past this machine. */
  private readonly checkNow = new Set<string>();
  private dispatchCommand: AgentWorkspaceCommandDispatcher | null = null;
  private _onlyGroup: AgentWorkspaceCategoryGroup | null = null;
  /** The rows a `/setup` topic shows; null shows every row. */
  private _onlyActionIds: ReadonlySet<string> | null = null;
  private _onboardingState: OnboardingState | null = null;
  private _revealedOnboardingCategoryIds = new Set<string>(); // monotonic reveal set
  private _awaitingRecapDismiss = false; // true while showing recap before final close

  open(context: CommandContext, dispatchCommand: AgentWorkspaceCommandDispatcher, categoryId?: string, onlyGroup?: AgentWorkspaceCategoryGroup, requestRender?: () => void): void {
    this.requestRender = requestRender ?? null;
    this.context?.nativeWorkLedger?.close();
    this.context = context;
    this.workContextScroll = 0;
    context.nativeWorkLedger?.open();
    this.dispatchCommand = dispatchCommand;
    this.reports.clear();
    this.checkNow.clear();
    this._onlyGroup = onlyGroup ?? null;
    this._onlyActionIds = null;
    this._awaitingRecapDismiss = false;
    this.runtimeSnapshot = buildAgentWorkspaceSetupPart(context);
    const shellPaths = context.workspace?.shellPaths;
    this._onboardingState = computeOnboardingStateFromSnapshot(this.runtimeSnapshot, shellPaths);
    if (this._onboardingState) updateRevealedOnboardingCategories(this._onboardingState, this._revealedOnboardingCategoryIds);
    this.active = true;
    this.focusPane = 'actions';
    this.status = 'Ready. Choose an operator flow; ordinary assistant work stays in the main conversation.';
    this.lastActionResult = null;
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
    }
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
      this.runtimeSnapshot = buildAgentWorkspaceSetupPart(context);
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
    this.active = false;
    this.context?.nativeWorkLedger?.close();
    this.actionSearchActive = false;
    this.actionSearchQuery = '';
    this._onlyGroup = null;
    this._onlyActionIds = null;
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
    // The setup forms are found through /setup, one topic at a time, never listed here.
    return AGENT_WORKSPACE_CATEGORIES.filter((category) => category.group !== 'SETUP');
  }

  /** Show only these rows of the open category (a `/setup` topic's form). */
  showOnlyActions(actionIds: readonly string[]): void {
    this._onlyActionIds = new Set(actionIds);
    this.selectedActionIndex = 0;
    this.clampSelection();
  }

  get selectedCategory(): AgentWorkspaceCategory {
    return this.categories[this.selectedCategoryIndex] ?? this.categories[0]!;
  }

  get actions(): readonly AgentWorkspaceAction[] {
    if (this.actionSearchActive) return this.actionSearchResults.map((result) => result.action);
    const base = this.selectedCategory.actions.filter((action) => isAgentWorkspaceActionVisible(this.context, action)
      && (!this._onlyActionIds || this._onlyActionIds.has(action.id)));
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

  settingActionDisplay(action: AgentWorkspaceAction): AgentWorkspaceSettingActionDisplay | null {
    return buildAgentWorkspaceSettingActionDisplay(this.context, action);
  }

  /** A setting row's name, what it does, value and default, in the setting's own words. */
  settingFacts(action: AgentWorkspaceAction): AgentWorkspaceSettingFacts | null {
    return readAgentWorkspaceSettingFacts(this.context, action);
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
    this.runtimeSnapshot = buildAgentWorkspaceSetupPart(this.context);
    this.reports.clear();
    // Ctrl+R also checks the selected row's report now, wherever it reads.
    const selected = this.selectedAction ? this.reportCommandFor(this.selectedAction) : undefined;
    if (selected) this.checkNow.add(selected);
    this.readHostSetup(true);
    this.status = 'Runtime context refreshed; checking the connected host again.';
    this.lastActionResult = { kind: 'refreshed', title: 'Runtime context refreshed', detail: 'Provider, model, session, local memory, runtime endpoint, and Agent knowledge route posture were re-read from the live command context. The connected host is being checked again; its setup steps update when it answers.' };
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

  activateSelected(requestRender?: () => void): void {
    activateAgentWorkspaceSelection(this, requestRender);
  }

  /**
   * The short report of `command` (its report action: what the command
   * prints when run bare), for the pane beside a selected row. Read the first
   * time a row of that command is selected in this opening, by running that
   * read exactly as the command does, but only when the report reads nothing
   * past this machine (`readsOnlyThisMachine`); any other waits for Ctrl+R.
   * Until it lands the reading says so.
   * Undefined for a command with no report that only reads.
   */
  /** The command whose report goes with a row: the command it runs, or `/model` for a model picker. */
  reportCommandFor(action: AgentWorkspaceAction): string | undefined {
    if (action.kind === 'act') return action.act?.command;
    if (action.kind === 'model-picker') return 'model';
    return undefined;
  }

  commandReport(command: string): CommandReportReading | undefined {
    const known = this.reports.get(command);
    if (known) return known;
    const context = this.context;
    const described = describedCommandByName(command);
    const action = described?.report ? described.actions.find((candidate) => candidate.id === described.report) : undefined;
    // Only a read that needs nothing filled in, and never one that opens a screen.
    if (!context || !described || !action || action.id === 'open' || action.touches !== 'reads' || action.lasts !== 'not-a-change'
      || action.inputs.some((input) => input.required === true)) return undefined;
    const reading: CommandReportReading = { command, line: `/${command}${action.word ? ` ${action.word}` : ''}`, label: action.label, lines: null };
    // Selecting a row never reaches past this machine: such a report waits for Ctrl+R.
    if (action.readsOnlyThisMachine !== true && !this.checkNow.has(command)) return { ...reading, waiting: true };
    this.reports.set(command, reading);
    const run = action.run as unknown as (values: Readonly<Record<string, string>>, ctx: CommandContext) => ReturnType<ActionDescription<never>['run']>;
    void captureCommandPrint(context, () => run({}, context)).then((outcome) => {
      if (this.context !== context || this.reports.get(command) !== reading) return;
      const returned = outcome.ok ? outcome.value : undefined;
      const text = outcome.ok
        ? [...outcome.lines, typeof returned === 'string' ? returned : isCommandReport(returned) ? renderCommandReport(returned) : ''].join('\n')
        : (() => { const refused = readRefusal(outcome.error); return refused ? formatRefusal(refused) : outcome.error instanceof Error ? outcome.error.message : String(outcome.error); })();
      this.reports.set(command, { ...reading, lines: text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0) });
      this.requestRender?.();
    });
    return reading;
  }

  /** Opens the row's described action over the composer (the workspace closes); false when this surface cannot. */
  openGuidedAction(target: WorkspaceActionTarget): boolean {
    const context = this.context;
    if (!context?.openSelection) return false;
    this.closeToComposer();
    return openWorkspaceAction(target, context);
  }

  hasCommandDispatch(): boolean {
    return Boolean(this.context?.executeCommand && this.dispatchCommand);
  }

  dispatchWorkspaceCommand(command: string, behavior?: 'inline' | 'compose' | 'exit', displayCommand?: string): void {
    this.dispatchCommand?.(command, behavior, displayCommand);
  }

  clampSelection(): void {
    this.selectedCategoryIndex = Math.max(0, Math.min(this.selectedCategoryIndex, this.categories.length - 1));
    this.selectedActionIndex = Math.max(0, Math.min(this.selectedActionIndex, this.actions.length - 1));
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
    if (effect.kind === 'open') {
      // A value to type, or a permission change to look at first: the settings screen, at this setting.
      if (!this.context?.openSettingsModal) {
        this.status = 'The settings screen cannot be shown here.';
        this.lastActionResult = { kind: 'error', title: 'Settings unavailable', detail: `Change it with /settings set ${effect.key}.`, safety: action.safety };
        return;
      }
      this.context.openSettingsModal(effect.key);
      this.status = effect.status;
      this.lastActionResult = effect.result;
      requestRender?.();
      return;
    }
    void this.applySettingValue(effect.setting, effect.value, requestRender);
  }

  /**
   * The import row reads the sources once into a plan and shows it in the
   * confirm dialog; nothing is written until the owner confirms, and then
   * exactly that plan is.
   */
  importTuiSettings(requestRender?: () => void): void {
    const plan = planAgentWorkspaceTuiSettingsImport(this.context);
    if (!plan || !agentWorkspaceTuiSettingsImportHasChanges(plan)) {
      void this.applyTuiSettingsImport(plan, requestRender);
      return;
    }
    const detail = describeAgentWorkspaceTuiSettingsImportPlan(plan);
    this.status = 'Review the GoodVibes settings import.';
    this.lastActionResult = { kind: 'guidance', title: 'GoodVibes settings import: what would change', detail, safety: 'safe' };
    const confirm = this.context?.confirm;
    if (!confirm) {
      this.status = 'Nothing was imported: this surface cannot ask before importing.';
      return;
    }
    void confirm({ title: 'Import GoodVibes settings', body: detail, confirmLabel: 'Import them', cancelLabel: 'Leave as is', tone: 'primary' }).then((go) => {
      if (!go) {
        this.status = 'GoodVibes settings import left as is; nothing was written.';
        this.lastActionResult = null;
        requestRender?.();
        return;
      }
      void this.applyTuiSettingsImport(plan, requestRender);
    });
  }

  private async applySettingValue(setting: AgentConfigSetting, value: unknown, requestRender?: () => void): Promise<void> {
    const outcome = await applyAgentWorkspaceSettingValue(this.context, setting, value);
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceSetupPart(this.context) : this.runtimeSnapshot;
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
}
