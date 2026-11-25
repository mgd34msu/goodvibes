import { openWorkspaceAction, type WorkspaceActionTarget } from './workspace-actions.ts';
import { describedCommandByName, isCommandReport, renderCommandReport, type ActionDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import { formatRefusal, readRefusal } from '@goodvibes/engine/errors';
import { captureCommandPrint } from './workspace-command-output.ts';
import type { AgentConfigSetting } from '../config/settings-catalog.ts';
import type { CommandContext } from './command-registry.ts';
import { activateAgentWorkspaceSelection } from './agent-workspace-activation.ts';
import { AGENT_WORKSPACE_CATEGORIES } from './agent-workspace-categories.ts';
import { jumpAgentWorkspaceSelection, moveAgentWorkspaceSelection, selectAgentWorkspaceCategory } from './agent-workspace-navigation.ts';
import { appendAgentWorkspaceActionSearchText, backspaceAgentWorkspaceActionSearch, beginAgentWorkspaceActionSearch, clearAgentWorkspaceActionSearch, commitAgentWorkspaceActionSearchSelection, searchAgentWorkspaceActions } from './agent-workspace-search.ts';
import { applyAgentWorkspaceSettingValue, applyAgentWorkspaceTuiSettingsImport, buildAgentWorkspaceSettingActionDisplay, buildAgentWorkspaceSettingActionEffect, readAgentWorkspaceSettingFacts, type AgentWorkspaceSettingFacts, isAgentWorkspaceActionVisible, planAgentWorkspaceTuiSettingsImport, type AgentWorkspaceSettingActionDisplay, type TuiSettingsImportPlan } from './agent-workspace-settings.ts';
import { buildAgentWorkspaceSetupPart } from './agent-workspace-snapshot.ts';
import { checkAgentWorkspaceHostSetup } from './agent-workspace-setup-host-status.ts';
import { resolveConnectedHostConnection } from './connected-host-routes.ts';
import type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryGroup, AgentWorkspaceCommandDispatcher, AgentWorkspaceFocusPane, AgentWorkspaceSetupPart } from './agent-workspace-types.ts';
import { ONBOARDING_COMPLETE_SYNTHETIC_ACTION, shouldShowOnboardingFinishFooter } from './agent-workspace-onboarding-finish.ts';
import { completeOnboardingAction, onSubscriptionLoginSuccessAction } from './agent-workspace-onboarding-actions.ts';
import { computeOnboardingStateFromSnapshot, deriveOnboardingEntry, updateRevealedOnboardingCategories } from './agent-workspace-onboarding-state.ts';
import type { OnboardingState } from '../runtime/onboarding/onboarding-state.ts';
import { agentRuntimeProfileName } from '../agent/runtime-profile.ts';

export type { AgentWorkspaceChannelRisk, AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
export type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryId, AgentWorkspaceCommandDispatcher, AgentWorkspaceFocusPane, AgentWorkspaceLocalLibraryItem, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
export { AGENT_WORKSPACE_MODAL_NAME } from './agent-workspace-types.ts';
export { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
export { handleAgentWorkspaceToken } from './agent-workspace-token.ts';

/**
 * How long a report's reading is shared before it is read again, and after
 * which a reading of something that changes on its own (a host, a mailbox, a
 * provider) is marked "may be out of date": those change within minutes.
 */
export const AGENT_WORKSPACE_REPORT_FRESH_MS = 5 * 60_000;

/** A command's short report as the pane shows it: null lines while it is being read. */
export interface CommandReportReading {
  readonly command: string;
  /** The line that prints it. */
  readonly line: string;
  /** The report action's own name. */
  readonly label: string;
  readonly lines: readonly string[] | null;
  /** When the read finished (ms since the epoch); absent while it is not read yet or still reading. */
  readonly readAt?: number;
  /** Why the read failed: the command's refusal or error, in its own words. */
  readonly failed?: string;
  /**
   * The connected daemon did not answer (its address): the read failed for that
   * reason, or `lines` hold only what this computer has. Read again by itself
   * when the daemon answers again.
   */
  readonly daemonUnanswered?: string;
}

/** Refusal codes that mean the connected daemon did not answer (connected-host-client). */
const DAEMON_UNANSWERED_CODES: ReadonlySet<string> = new Set(['host_timeout', 'host_unreachable']);

/**
 * "Agent home default · model rt-1 (rtfake) · daemon on this computer": the
 * Agent home (profile) of this session, the model it answers with and its
 * provider ("signed in with a subscription" when that is a stored sign-in
 * rather than a key), and which daemon it works with. One read of the sign-in
 * store per opening.
 */
function describeAgentWorkspaceIdentity(context: CommandContext): string {
  const home = agentRuntimeProfileName(context.workspace?.shellPaths?.homeDirectory ?? '') ?? 'default';
  const provider = context.session?.runtime?.provider ?? '';
  const model = context.session?.runtime?.model ?? '';
  let signedIn = false;
  try {
    signedIn = provider !== '' && context.platform?.subscriptionManager?.hasSignIn?.(provider) === true;
  } catch {
    // An unreadable sign-in store leaves the provider named without how it signs in.
  }
  const modelName = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
  const providerWords = provider ? `${provider}${signedIn ? ', signed in with a subscription' : ''}` : '';
  const modelWords = modelName ? `model ${modelName}${providerWords ? ` (${providerWords})` : ''}` : providerWords ? `provider ${providerWords}` : '';
  let daemon = '';
  try {
    const url = context.platform?.configManager?.get('daemon.connectedHost.url');
    daemon = typeof url === 'string' && url.trim() !== '' ? `daemon at ${url.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : 'daemon on this computer';
  } catch {
    // An unreadable setting leaves the daemon unnamed.
  }
  return [`Agent home ${home}`, modelWords, daemon].filter(Boolean).join(' · ');
}

export class AgentWorkspace {
  public active = false;
  public focusPane: AgentWorkspaceFocusPane = 'actions';
  public selectedCategoryIndex = 0;
  public selectedActionIndex = 0;
  /** What the last thing done here did; empty (no status line) while nothing has happened. */
  public status = '';
  /** Only the setup part: the workspace reads its setup steps and onboarding route, nothing else of the snapshot. */
  public runtimeSnapshot: AgentWorkspaceSetupPart | null = null;
  /** The Agent home this session runs in and the account its chat model uses, read when the workspace opens (its header). */
  public identity = '';
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
  /** When the shown result arrived (ms since the epoch), and the result that time belongs to: its title says when. */
  public resultAt = 0;
  public resultAtFor: AgentWorkspaceActionResult | null = null;
  private context: CommandContext | null = null;
  /**
   * Each command's short report, read by itself in the background when an area
   * holding one of its rows is shown, and shared while fresh: moving between
   * areas or opening the workspace again does not read the same report again
   * until it is AGENT_WORKSPACE_REPORT_FRESH_MS old. Ctrl+R reads again now.
   */
  private readonly reports = new Map<string, CommandReportReading>();
  /** The context the held reports were read with; another context starts them afresh. */
  private reportsFor: CommandContext | null = null;
  /** Commands a form opened from here may have changed something through; their reports are read again on return. */
  private readonly actedOn = new Set<string>();
  private dispatchCommand: AgentWorkspaceCommandDispatcher | null = null;
  private _onlyGroup: AgentWorkspaceCategoryGroup | null = null;
  /** The rows a `/setup` topic shows; null shows every row. */
  private _onlyActionIds: ReadonlySet<string> | null = null;
  private _onboardingState: OnboardingState | null = null;
  private _revealedOnboardingCategoryIds = new Set<string>(); // monotonic reveal set
  private _awaitingRecapDismiss = false; // true while showing recap before final close

  open(context: CommandContext, dispatchCommand: AgentWorkspaceCommandDispatcher, categoryId?: string, onlyGroup?: AgentWorkspaceCategoryGroup, requestRender?: () => void): void {
    this.requestRender = requestRender ?? null;
    this.typedAwayFrom = null;
    this.context = context;
    this.workContextScroll = 0;
    this.dispatchCommand = dispatchCommand;
    this.keepFreshReports(context);
    this.lastShownArea = null;
    this.actedOn.clear();
    this._onlyGroup = onlyGroup ?? null;
    this._onlyActionIds = null;
    this._awaitingRecapDismiss = false;
    this.runtimeSnapshot = buildAgentWorkspaceSetupPart(context);
    this.identity = describeAgentWorkspaceIdentity(context);
    const shellPaths = context.workspace?.shellPaths;
    this._onboardingState = computeOnboardingStateFromSnapshot(this.runtimeSnapshot, shellPaths);
    if (this._onboardingState) updateRevealedOnboardingCategories(this._onboardingState, this._revealedOnboardingCategoryIds);
    this.active = true;
    this.focusPane = 'actions';
    this.status = '';
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
      // The reports of the area shown are read by themselves, in the background.
      this.readShownAreaReports();
    }
  }

  private requestRender: (() => void) | null = null;

  /** Keep the readings that are finished and fresh for this context; drop the rest so they are read again. */
  private keepFreshReports(context: CommandContext): void {
    if (this.reportsFor !== context) {
      this.reports.clear();
      this.reportsFor = context;
      return;
    }
    const now = Date.now();
    for (const [command, reading] of this.reports) {
      if (reading.readAt === undefined || reading.failed !== undefined || reading.daemonUnanswered !== undefined
        || now - reading.readAt > AGENT_WORKSPACE_REPORT_FRESH_MS) this.reports.delete(command);
    }
  }

  /**
   * The connected daemon answers again (the adoption edge, runtime/daemon-attach-signal.ts):
   * every report that failed or fell back because it did not answer is read again, with the
   * host check while the workspace is open. No key press, no timer.
   */
  daemonAnswered(): void {
    // Every failed reading goes too: a report that reads a mailbox or a provider through the daemon
    // failed with it, and one read each is the whole cost.
    let any = false;
    for (const [command, reading] of this.reports) {
      if (reading.daemonUnanswered !== undefined || reading.failed !== undefined) { this.reports.delete(command); any = true; }
    }
    if (!this.active || !this.context) return;
    this.readHostSetup(true);
    if (any) this.readShownAreaReports();
    this.requestRender?.();
  }

  /**
   * Read, in the background, the report of every row of the area on screen that
   * has one and is not held yet: the screen is drawn at once with "reading…"
   * on those and fills in as each arrives. One read per report while fresh.
   * Only for a workspace a person sees (one that can repaint).
   */
  readShownAreaReports(): void {
    if (!this.requestRender || !this.active) return;
    // A failed reading is never held as fresh: coming to an area again reads its failed reports again.
    const shown = this.selectedActionCategory.id;
    const arrived = shown !== this.lastShownArea;
    this.lastShownArea = shown;
    for (const action of this.actions) {
      const command = this.reportCommandFor(action);
      if (!command) continue;
      if (arrived && this.reports.get(command)?.failed !== undefined) this.reports.delete(command);
      this.commandReport(command);
    }
  }

  /** The area whose reports were last read for the screen; arriving at another re-reads its failed ones. */
  private lastShownArea: string | null = null;

  /**
   * Read the reports of Home at the Agent's start, so what is waiting is
   * already read when the workspace is first opened. Nothing is drawn; the
   * readings are held for the opening that follows.
   */
  readAtStart(context: CommandContext, requestRender: () => void): void {
    this.keepFreshReports(context);
    const category = AGENT_WORKSPACE_CATEGORIES.find((candidate) => candidate.id === 'home');
    for (const action of category?.actions ?? []) {
      const command = this.reportCommandFor(action);
      if (command) this.commandReport(command, requestRender, context);
    }
  }

  /**
   * The setup steps for the connected host read the session's reading of it.
   * The first open takes one bounded reading; when it lands the snapshot is
   * rebuilt so the steps show the answer instead of "checking".
   */
  private readHostSetup(force: boolean): void {
    const context = this.context;
    if (!context) return;
    // Read again on each opening once the held reading is no longer fresh; Ctrl+R forces it.
    void checkAgentWorkspaceHostSetup(context, { force, freshMs: AGENT_WORKSPACE_REPORT_FRESH_MS }).then(() => {
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
    // Back from a form that changed something: those commands' reports are read again at the next draw.
    for (const command of this.actedOn) this.reports.delete(command);
    this.actedOn.clear();
    this.active = true;
    this.clampSelection();
  }

  close(): void {
    this.active = false;
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

  /** Where typing left the workspace for the composer: Esc on the unsent text comes back to this area and row. */
  private typedAwayFrom: {
    readonly categoryId: string;
    readonly actionIndex: number;
    readonly focusPane: AgentWorkspaceFocusPane;
    readonly onlyGroup: AgentWorkspaceCategoryGroup | null;
    readonly onlyActionIds: ReadonlySet<string> | null;
    readonly onboardingState: OnboardingState | null;
  } | null = null;

  /** A printable key starts a message: the workspace closes into the composer and remembers where it was. */
  closeToComposerByTyping(): void {
    this.typedAwayFrom = {
      categoryId: this.selectedActionCategory.id,
      actionIndex: this.selectedActionIndex,
      focusPane: this.focusPane,
      onlyGroup: this._onlyGroup,
      onlyActionIds: this._onlyActionIds,
      onboardingState: this._onboardingState,
    };
    this.closeToComposer();
  }

  /** True while typing has taken the person from this workspace to the composer. */
  get leftByTyping(): boolean {
    return this.typedAwayFrom !== null && !this.active;
  }

  /** The area typing left, by name ("Research"), while Esc leads back to it; null otherwise. */
  get typedAwayFromArea(): string | null {
    if (!this.leftByTyping || !this.typedAwayFrom) return null;
    const id = this.typedAwayFrom.categoryId;
    return AGENT_WORKSPACE_CATEGORIES.find((category) => category.id === id)?.label ?? null;
  }

  /** The person sent or cleared what they typed: Esc no longer leads back here. */
  forgetTypedAway(): void {
    this.typedAwayFrom = null;
  }

  /** Back to the exact area and row typing left; false when there is none to go back to. */
  returnFromTyping(): boolean {
    const back = this.typedAwayFrom;
    this.typedAwayFrom = null;
    if (!back || !this.context || this.active) return false;
    this._onlyGroup = back.onlyGroup;
    this._onlyActionIds = back.onlyActionIds;
    this._onboardingState = back.onboardingState;
    this.reopen();
    const index = this.categories.findIndex((category) => category.id === back.categoryId);
    if (index >= 0) this.selectedCategoryIndex = index;
    this.selectedActionIndex = back.actionIndex;
    this.focusPane = back.focusPane;
    this.clampSelection();
    return true;
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
    if (shouldShowOnboardingFinishFooter(this.selectedCategory, base, this.onboardingReadyToChat)) {
      return [...base, ONBOARDING_COMPLETE_SYNTHETIC_ACTION];
    }
    return base;
  }

  /**
   * Whether setup can finish now (a model answers), the one rule the finish row and
   * Apply & close both follow; undefined when no onboarding state is known.
   */
  get onboardingReadyToChat(): boolean | undefined {
    return this._onlyGroup === 'ONBOARDING' ? this._onboardingState?.readyToChat : undefined;
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
    this.status = '';
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
    // Ctrl+R reads every report again now, starting with the area on screen.
    this.reports.clear();
    this.readShownAreaReports();
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

  /** The command whose report goes with a row: the command it runs, or `/model` for a model picker. */
  reportCommandFor(action: AgentWorkspaceAction): string | undefined {
    if (action.kind === 'act') return action.act?.command;
    if (action.kind === 'model-picker') return 'model';
    return undefined;
  }

  /** The report action a command's rows show beside them: a read that needs nothing filled in and opens no screen. */
  private reportAction(command: string): ActionDescription<never> | undefined {
    const described = describedCommandByName(command);
    const action = described?.report ? described.actions.find((candidate) => candidate.id === described.report) : undefined;
    if (!described || !action || action.id === 'open' || action.touches !== 'reads' || action.lasts !== 'not-a-change'
      || action.inputs.some((input) => input.required === true)) return undefined;
    return action;
  }

  /**
   * Where the row's report reads, without reading it: 'here' (stored things on
   * this computer, which change only when you change them), 'past' (a host, a
   * mailbox or a provider, which change on their own), or undefined (the row
   * has no report). Only a 'past' reading is marked when it grows old.
   */
  reportReach(action: AgentWorkspaceAction): 'here' | 'past' | undefined {
    const command = this.reportCommandFor(action);
    const report = command ? this.reportAction(command) : undefined;
    if (!report) return undefined;
    return report.readsOnlyThisMachine === true ? 'here' : 'past';
  }

  commandReport(command: string, requestRender?: () => void, readWith?: CommandContext): CommandReportReading | undefined {
    const known = this.reports.get(command);
    if (known) return known;
    const context = readWith ?? this.context;
    const action = this.reportAction(command);
    if (!context || !action) return undefined;
    const reading: CommandReportReading = { command, line: `/${command}${action.word ? ` ${action.word}` : ''}`, label: action.label, lines: null };
    this.reports.set(command, reading);
    const run = action.run as unknown as (values: Readonly<Record<string, string>>, ctx: CommandContext) => ReturnType<ActionDescription<never>['run']>;
    // The read runs with a context that also hears "the daemon did not answer" from a list that fell back to this computer.
    let fellBack: string | undefined;
    const daemonAddress = (): string => resolveConnectedHostConnection(context).baseUrl;
    const readContext = Object.create(context, {
      noteDaemonUnanswered: { value: (daemon: string | undefined) => { fellBack = daemon ?? daemonAddress(); } },
    }) as CommandContext;
    void captureCommandPrint(context, () => run({}, readContext)).then((outcome) => {
      if (this.reportsFor !== context || this.reports.get(command) !== reading) return;
      const readAt = Date.now();
      const repaint = requestRender ?? this.requestRender;
      if (!outcome.ok) {
        const refused = readRefusal(outcome.error);
        if (refused && DAEMON_UNANSWERED_CODES.has(refused.code)) {
          // Said in plain words by the pane; the refusal's next step is for a model.
          this.reports.set(command, { ...reading, lines: [], readAt, failed: '', daemonUnanswered: daemonAddress() });
        } else {
          const why = refused ? formatRefusal(refused) : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          this.reports.set(command, { ...reading, lines: [], readAt, failed: why.replace(/\s+/g, ' ').trim() || 'no reason was given' });
        }
        repaint?.();
        return;
      }
      const returned = outcome.value;
      const text = [...outcome.lines, typeof returned === 'string' ? returned : isCommandReport(returned) ? renderCommandReport(returned) : ''].join('\n');
      const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
      this.reports.set(command, { ...reading, readAt, lines, ...(fellBack !== undefined ? { daemonUnanswered: fellBack } : {}) });
      repaint?.();
    });
    return reading;
  }

  /** Opens the row's described action over the composer (the workspace closes); false when this surface cannot. */
  openGuidedAction(target: WorkspaceActionTarget): boolean {
    const context = this.context;
    if (!context?.openSelection) return false;
    // A change made from this row makes its command's report out of date: it is read again on the way back.
    const changes = describedCommandByName(target.command)?.actions.find((candidate) => candidate.id === target.action);
    if (!changes || changes.lasts !== 'not-a-change') this.actedOn.add(target.command);
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
   * The import row is the request: it reads the sources once into a plan and
   * imports exactly that plan at once. The answer lists what changed and names
   * the copy of the settings from before, which puts them back.
   */
  importTuiSettings(requestRender?: () => void): void {
    void this.applyTuiSettingsImport(planAgentWorkspaceTuiSettingsImport(this.context), requestRender);
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
