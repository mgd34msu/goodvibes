/**
 * places/, the place framework both terminal programs use (BUILDING-A-PLACE.md
 * in the overhaul records says how to declare one).
 *
 * `wirePlaces` is the one call a program makes: it gives its command
 * context, its owner path, its key table and its way to the daemon, and gets
 * back how to open the menu and a place. Every place is declared once here;
 * each place's keys are registered as its key context in the program's table,
 * and the calls the program's gate holds are posted to the daemon's owner
 * inbox, where Waiting for you reads them with everything else.
 */
import type { SurfaceModalHost } from '../surface-modal-host.js';
import { createPlaceHost, type PlaceHost, type PlaceHostOptions, type PlaceKeyTable } from './place-host.js';
import { PlaceMenu } from './place-menu.js';
import { PlaceModal } from './place-modal.js';
import { learnSourceNotices } from './source-notices.js';
import type { AnyPlace } from './place-types.js';
import { keysProgramActions, keysSource } from './keys-place.js';
import { waitingPlaceSources } from './waiting-sources.js';
import { placeKeyContext } from './place-keys.js';
import { bridgeHeldCallsToDaemonInbox } from './held-calls-inbox.js';
import { bridgeHeldSendsToDaemonInbox } from './held-sends-inbox.js';
import { SESSIONS_PLACE, runSessionsViewKey, sessionsViewKeyContext } from './sessions-place.js';
import type { PlaceProgramSource } from './place-host.js';
import {
  SYSTEM_PLACE, setupProgramActions, systemHealthSource, systemLinksSource, systemNoticesSource, systemReleaseSource, systemSessionSource, systemSupportSource, type SystemSessionReader,
} from './system-place.js';
import type { SetupPlaceHooks } from '../setup-command.js';
import { localTasks } from '../tasks-runtime-commands.js';
import { unansweredSource } from '../native/work-command.js';
import type { CommandActionContext } from '../command-actions/types.js';
import { MONEY_PLACE, SPENDING_HERE_SOURCE } from './money-place.js';
import { conversationSpendingSource, type UsageTracker } from './conversation-spending.js';
export { spendingAlertWatch, UsageTracker, type UsageTrackerDeps } from './conversation-spending.js';
import { codePlacePrograms, codePlaceSources } from './code-sources.js';
import { BROWSER_PLACES } from './browser.js';
import { agentsPlaceSources, bindWorkAgentLists, evaluationsPlaceSource } from './work-agents-lists.js';
import { bindToolsSkillsLists } from './tools-skills-lists.js';
import { bindToolsLists } from './tools-lists.js';
// Money: the lists a Money form chooses from (a card, a repeat purchase, a shop), read from the daemon (money-lists.ts).
import { bindMoneyLists } from './money-lists.js';
import { bindMemoryStoreLists } from './memory-stores-lists.js';
import { postHookRunsToDaemon, type HookRunsSource } from './hook-runs-poster.js';
import { postDecidedCallsToDaemon } from './policy-audit-poster.js';
import { programNotices } from '../program-notices.js';
import { toolsPlaceSource } from '../tools-capabilities.js';
import { mcpServersPlaceSource, type McpCommandContext } from '../mcp-runtime-commands.js';
import { bindPluginLists } from '../plugin-trust-command.js';
import { CONVERSATION_PLACE, conversationComposerKeyContext, conversationPlaceSources, runConversationControlKey } from './conversation-place.js';
import { pinnedLinesPlaceSource } from './pinned-lines-entries.js';
import { followDaemonContextWindows } from '../context-windows-follow.js';
import { followDaemonModelServers, type ModelServersRegistry } from '../model-servers-follow.js';
import { followDaemonSpendingAlert } from '../spending-alert-follow.js';
import { followPurchaseNotices } from '../purchase-notices-follow.js';
// Models and providers: models, providers and sign-ins, routing, services, media providers, moving them (models-place.ts).
export { MODELS_PLACE } from './models-place.js';
import { SAFETY_PLACE } from './safety-place.js';
import { safetyPlaceSources } from './safety-sources.js';
import { followPolicyInForce } from '../policy-follow.js';
// Settings: the one settings screen both programs show, opened by /settings, from System and from the menu (settings-screen/).
import { SettingsScreen, settingsKeyContext, type SettingsScreenProgram } from '../settings-screen/index.js';
import type { SettingsTargetOutcome } from '../settings-navigation.js';
export type { SettingsScreenProgram } from '../settings-screen/index.js';

/** What this program's gate reads that the daemon decides: its copy of the policy in force, and this folder's trust. */
interface SafetyStateHolder {
  readonly extensions?: { readonly policyRuntimeState?: {
    getRegistry(): { followActivation(): { readonly changed: boolean; readonly problem?: string | undefined } };
    notify(): void;
    recordConfiguredBundleFailure(reason: string | null): void;
    /** Each call this program's gate decides (policy-audit-poster.ts posts them to the daemon's audit). */
    onDecision?(listener: (entry: { readonly callId: string }) => void): () => void;
  } | undefined } | undefined;
  readonly workspace?: { readonly workspaceTrustManager?: { load(): Promise<unknown> } | null | undefined } | undefined;
  readonly renderRequest?: (() => void) | undefined;
}

/**
 * Take in what the daemon changed: the one activation record into this program's copy of the policy
 * (permission-composition.ts `followPolicyActivation`), and this folder's trust from the shared register, so its
 * hooks file and the MCP servers its files name start or stop now and the gate decides by the new level.
 */
function followSafetyState(context: PlaceHostOptions['context']): (() => void) | undefined {
  const held = context as SafetyStateHolder;
  const state = held.extensions?.policyRuntimeState;
  const trust = held.workspace?.workspaceTrustManager ?? undefined;
  if (!state && !trust) return undefined;
  return () => {
    if (state) {
      const followed = state.getRegistry().followActivation();
      if (followed.problem) state.recordConfiguredBundleFailure(followed.problem);
      else if (followed.changed) state.notify();
    }
    if (trust) void trust.load().then(() => { held.renderRequest?.(); }, () => { /* read again on the next notice */ });
  };
}

// Permissions and safety: rules, secrets, this folder's trust, sign-in, who is who, tokens, grants, sandbox sessions (safety-place.ts).
export { SAFETY_PLACE } from './safety-place.js';
// Its program readers (and the sandbox sessions list), for the terminal programs only (safety-sources.ts).
export { safetyPlaceSources } from './safety-sources.js';
// The services of the security reviews that run where the conversation is (security-here.ts), for each program's session capabilities.
export { securityHereServices, type SecurityHereLive } from '../security-here.js';

// This conversation: the controls on the conversation itself, each run from its row (conversation-place.ts).
export { CONVERSATION_PLACE } from './conversation-place.js';

// Tools and extensions: the hooks, the hook trace, the tools the model can call here (tools-place.ts).
export { TOOLS_PLACE } from './tools-place.js';
export { postHookRunsToDaemon, type HookRunsSource } from './hook-runs-poster.js';

export { CODE_PLACE } from './code-place.js';

export { DEVICES_PLACE } from './devices-place.js';
export { WORK_PLACE } from './work-place.js';
export { MEMORY_PLACE } from './memory-place.js';
// Work and agents, the second half: remote runners and recorded runs (work-agents-entries.ts).
export { bindWorkAgentLists, recordedRunsPlaceSource } from './work-agents-lists.js';
export { MONEY_PLACE } from './money-place.js';

export { SYSTEM_PLACE, setupProgramActions } from './system-place.js';

export { SESSIONS_PLACE } from './sessions-place.js';
export { MESSAGES_PLACE } from './messages-place.js';
// This program's notices of its own events, sent through the daemon's one webhook list (program-notices.ts).
export { programNotices, type ProgramNotices, type ProgramNoticeResult } from '../program-notices.js';
export { sessionsPlaceSources, type SessionsPlaceHost } from './sessions-sources.js';
export type { AnyPlace, PlaceAction, PlaceAnswer, PlaceCapabilityAction, PlaceCount, PlaceDeclaration, PlaceDetailLine, PlaceFollow, PlaceGroupId, PlaceItem, PlaceList, PlaceProgramAction, PlaceProgramName, PlaceRow, PlaceSource } from './place-types.js';
export { definePlace } from './place-types.js';
export type { PlaceHost, PlaceHostOptions, PlaceKeyTable, PlaceProgramSource, PlacePrograms, PlaceRunOutcome, ResolvedCapability } from './place-host.js';
export { createPlaceHost, resolveCapability } from './place-host.js';
export { PlaceModal, READ_AGAIN_KEY } from './place-modal.js';
export { PlaceMenu } from './place-menu.js';
export { AUTOMATION_PLACE } from './automation-place.js';
export { WAITING_PLACE } from './waiting-place.js';
export { KEYS_PLACE } from './keys-place.js';
export { MORE_KEYS_ACTION, placeKeyContext, placeKeyContextId, READ_AGAIN_ACTION } from './place-keys.js';
export { bridgeHeldCallsToDaemonInbox } from './held-calls-inbox.js';

/** Every place, in menu order of their groups (the menu orders by group, not by this list). */
// System holds the Keys place's list and actions as its last tab (system-place.ts).
// One registry: every place the browser draws too (browser.ts), and the one only a terminal program draws.
export const PLACES: readonly AnyPlace[] = [...BROWSER_PLACES, CONVERSATION_PLACE];

/** The Work place's checklist: this program's view of the project's shared checklist file, told of every commit. */
function checklistSource(context: PlaceHostOptions['context']): PlaceProgramSource | undefined {
  const plan = (context as { readonly workspace?: { readonly workPlan?: { snapshotNow(): { readonly tasks: readonly unknown[] }; subscribe(listener: () => void): () => void } | null } }).workspace?.workPlan;
  if (!plan) return undefined;
  return { read: () => plan.snapshotNow().tasks, subscribe: (onChange) => plan.subscribe(onChange) };
}

/** The Work place's "Tasks here": this program's own background tasks, read when the place opens and on `r`. */
function tasksHereSource(context: PlaceHostOptions['context']): PlaceProgramSource {
  return { read: () => localTasks(context) ?? [], subscribe: () => () => {} };
}

export type WirePlacesOptions = Omit<PlaceHostOptions, 'openPlace' | 'sources' | 'programActions' | 'modals' | 'keys'> & {
  readonly modals: Pick<SurfaceModalHost, 'push' | 'close'>;
  readonly keys: PlaceKeyTable;
  /** The program's own name, on the held calls it posts (`tui`, `agent`). */
  readonly program: 'tui' | 'agent';
  /** The sources the program holding the conversation supplies by name (the Sessions place's: sessions-sources.ts). */
  readonly sources?: Readonly<Record<string, PlaceProgramSource>> | undefined;
  /** The System place's Setup list over this program's `/setup` (setup-command.ts `setupPlaceHooks`). */
  readonly setup?: SetupPlaceHooks | undefined;
  /** The System place's "This session" list: this program's own report and print level (its `systemSessionOf`). */
  readonly systemSession?: SystemSessionReader | undefined;
  /** This program's hook runs as its dispatcher records them, posted to the daemon's one hook trace (hook-runs-poster.ts). */
  readonly hookRuns?: HookRunsSource | undefined;
  /** Told of every change to the agents this program runs (started, progressing, ended): the Work place's Your agents. */
  readonly agentChanges?: ((listener: () => void) => () => void) | undefined;
  /**
   * This program's provider registry: it reads the daemon's context window sizes again on each change
   * (context-windows-follow.ts), and takes the model servers the daemon finds on this computer (model-servers-follow.ts).
   */
  readonly providerRegistry?: ({ contextWindowsChanged(): void } & Partial<ModelServersRegistry>
    & Partial<Pick<import('@goodvibes/engine/platform/platform/providers').ProviderRegistry, 'onContextWindowLearned'>>) | undefined;
  /** Money: what this conversation used and cost, listed at the top of Spending (conversation-spending.ts). */
  readonly spending?: (() => UsageTracker | undefined) | undefined;
  /** Settings: what this program keeps itself and the pickers it draws, for the one settings screen (settings-screen/). */
  readonly settings?: (() => SettingsScreenProgram | undefined) | undefined;
};

export interface WiredPlaces {
  readonly host: PlaceHost;
  /**
   * Open the settings screen, at a topic, a list or a setting, else searching for the words; says where it landed
   * (`unreported` when this program gave no settings screen).
   */
  openSettings(target?: string): SettingsTargetOutcome | 'unreported';
  /** Open the menu of every place. */
  openMenu(): void;
  /** Open one place by id, on its list `start.list` when given; false when there is none by that id. */
  openPlace(id: string, start?: { readonly list?: string | undefined; readonly action?: string | undefined; readonly item?: string | undefined }): boolean;
  /** Stop what the places hold open (the held-call bridge). */
  stop(): void;
  /** Run what a place's key read in the composer names (`place.conversation-composer.<control>`), saying the outcome in the conversation. */
  runKey(action: string): void;
}

/**
 * A place as this program shows it: a list declared for other programs only (`PlaceList.programs`), or whose session
 * or program source this program does not keep (the Agent's held sends, in the terminal app), is left out, as the
 * web view leaves out every such list.
 */
function listsHere(place: AnyPlace, host: PlaceHost, program: 'tui' | 'agent'): AnyPlace {
  const lists = place.lists.filter((list) => (list.programs === undefined || list.programs.includes(program))
    && (list.source.kind === 'daemon' || host.source(list.source.name) !== undefined));
  // A control declared for other programs only (`PlaceCapabilityAction.programs`) is no control here.
  const actions = place.actions.filter((action) => action.kind === 'program' || action.programs === undefined || action.programs.includes(program));
  const shown = lists.length === place.lists.length || lists.length === 0 ? place : { ...place, lists };
  return actions.length === place.actions.length ? shown : { ...shown, actions };
}

/** Wire the places into one program: the menu, each place, their keys, sources and program actions, and its held calls. */
export function wirePlaces(options: WirePlacesOptions): WiredPlaces {
  // Each place's keys are a context of the program's key table: rebindable, checked for conflicts, listed in Keys.
  for (const place of PLACES) options.keys.registerContext(placeKeyContext(place));
  // Which change notices name each daemon source, from every declaration: an open place reads again only the lists a notice names.
  learnSourceNotices(PLACES);
  // This conversation's controls as keys read while writing a message, none bound until a person binds one.
  options.keys.registerContext(conversationComposerKeyContext());
  // Moving through this conversation (Sessions: the next and previous entry, what the message box waits on), none bound until a person binds one.
  options.keys.registerContext(sessionsViewKeyContext());
  // The settings screen's keys (settings-screen/keys.ts), rebindable and listed in Keys under "Settings".
  options.keys.registerContext(settingsKeyContext());
  // The remote runners' forms read the daemon's runners through this program's binding.
  if (options.capabilityBinding) bindWorkAgentLists(options.capabilityBinding);
  // The skills, bundles, presets and managed applies a form chooses from are the daemon's (tools-skills-entries.ts).
  if (options.capabilityBinding) bindToolsSkillsLists(options.capabilityBinding);
  // The notes, personas, routines, drafts and artifacts a form chooses from are the daemon's (memory-stores-entries.ts).
  if (options.capabilityBinding) bindMemoryStoreLists(options.capabilityBinding);
  // Tools and extensions: the plugin lists a form picks from read the daemon through this program's binding.
  if (options.capabilityBinding) bindPluginLists(options.capabilityBinding);
  // Tools and extensions: the hooks and marketplace lists a form picks from read the daemon through this program's binding.
  if (options.capabilityBinding) bindToolsLists(options.capabilityBinding);
  if (options.capabilityBinding) bindMoneyLists(options.capabilityBinding);
  const checklist = checklistSource(options.context);
  // Code and changes reads this program's own project folder, through its session capabilities' services.
  const code = (): ReturnType<NonNullable<PlaceHostOptions['sessionServices']>>['code'] => options.sessionServices?.().code;
  const sources = { ...(options.sources ?? {}), keys: keysSource(options.keys), ...(options.setup ? { setup: options.setup.source } : {}),
    ...(options.systemSession ? { 'system-session': systemSessionSource(options.systemSession) } : {}), ...(checklist ? { checklist } : {}),
    // System: this program's health and start, its notices, and (the terminal app's) release readiness (system-place.ts).
    ...(options.systemSession ? {
      'system-health': systemHealthSource(options.systemSession), 'system-notices': systemNoticesSource(options.systemSession),
      'system-support': systemSupportSource(options.program, options.systemSession),
      ...(options.program === 'tui' ? { 'system-release': systemReleaseSource(options.systemSession), 'system-links': systemLinksSource(options.systemSession) } : {}),
    } : {}), 'tasks-here': tasksHereSource(options.context), ...codePlaceSources(code),
    // Work: the work asked for and the message typed that have no answer from the daemon yet (native/work-command.ts).
    unanswered: unansweredSource(options.context as CommandActionContext),
    // Tools and extensions: the tools this program's model can call, through its session capabilities' services.
    tools: toolsPlaceSource(() => options.sessionServices?.().toolRegistry),
    // Tools and extensions: this program's own tool server connections (mcp-runtime-commands.ts).
    'mcp.servers': mcpServersPlaceSource(() => options.context as McpCommandContext),
    // This conversation: its controls, with what each acts on now, through its session capabilities' services.
    ...conversationPlaceSources(options.sessionServices, options.keys, options.program),
    // This conversation: the lines pinned in it (pinned-lines-entries.ts).
    ...pinnedLinesPlaceSource(options.sessionServices),
    // Permissions and safety: this conversation's permissions and plan mode, and the sandbox sessions this program started.
    ...safetyPlaceSources(options.sessionServices),
    // Waiting for you: the kinds of approval.
    ...waitingPlaceSources(),
    // Work and agents: the agents this program started, its work contracts and the archetypes (the terminal app's).
    ...agentsPlaceSources(options.sessionServices, options.agentChanges),
    // Money: this conversation's usage and cost at the top of Spending.
    ...(options.spending ? { [SPENDING_HERE_SOURCE]: conversationSpendingSource(options.spending) } : {}),
    // Work and agents: the task suites this program ran this session (the terminal app's).
    ...evaluationsPlaceSource(options.sessionServices) };
  let host: PlaceHost | undefined;
  const openPlace = (id: string, start?: { readonly list?: string | undefined; readonly action?: string | undefined; readonly item?: string | undefined }): boolean => {
    const place = PLACES.find((candidate) => candidate.id === id);
    if (!place || !host) return false;
    options.modals.push(new PlaceModal(listsHere(place, host, options.program), host, start));
    options.requestRender();
    return true;
  };
  host = createPlaceHost({
    ...options,
    sources,
    programActions: { ...keysProgramActions(options.keys), ...(options.setup ? setupProgramActions(options.setup) : {}), ...codePlacePrograms(code) },
    openPlace: (id, start) => { openPlace(id, start); },
    modals: options.modals,
  });
  const wired = host;
  // The calls this program's gate holds go to the daemon's owner inbox, beside the daemon's own.
  const stopHeld = bridgeHeldCallsToDaemonInbox({
    invoke: options.invoke,
    daemonEndpoint: options.daemonEndpoint,
    onDaemonBack: options.onDaemonBack,
    program: options.program,
  });
  // The sends the Agent's content check refused go to the same inbox, sent or dropped by the answer there (held-sends-inbox.ts).
  const stopHeldSends = options.program === 'agent' ? bridgeHeldSendsToDaemonInbox({
    invoke: options.invoke,
    daemonEndpoint: options.daemonEndpoint,
    onDaemonBack: options.onDaemonBack,
    told: (line) => {
      options.context.print(`[Sends] ${line}`);
      options.requestRender();
      // The model asked for the send: it learns how it ended on its next request.
      const notes = (options.context as { readonly session?: { readonly conversationManager?: { readonly hostInstructions?: { set(key: string, text: string, how: { once: boolean; append: boolean }): void } } } }).session?.conversationManager?.hostInstructions;
      try { notes?.set('replay', line, { once: true, append: true }); } catch { /* the line in the conversation says it */ }
    },
  }) : () => {};
  // The hooks this program runs go to the daemon's one hook trace, beside every other program's.
  let project: string | undefined;
  try { project = options.capabilityBinding?.caller(options.context as never).workingDirectory; } catch { project = undefined; }
  const stopHookRuns = options.hookRuns
    ? postHookRunsToDaemon({ runs: options.hookRuns, invoke: options.invoke, onDaemonBack: options.onDaemonBack, program: options.program, ...(project ? { project } : {}) })
    : () => {};
  // Mail, calendar and channels: this program's notices of its own events go through the daemon's one webhook list (program-notices.ts).
  const stopNotices = programNotices.bind({ invoke: options.invoke, onDaemonBack: options.onDaemonBack, program: options.program });
  // This conversation: a context window size set or cleared through the daemon reaches this program's next turn.
  const stopContextWindows = options.providerRegistry
    ? followDaemonContextWindows({
      daemonEndpoint: options.daemonEndpoint, onDaemonBack: options.onDaemonBack,
      registry: {
        contextWindowsChanged: () => options.providerRegistry!.contextWindowsChanged(),
        ...(options.providerRegistry.onContextWindowLearned ? { onContextWindowLearned: options.providerRegistry.onContextWindowLearned.bind(options.providerRegistry) } : {}),
      },
      // A limit this program's own turn learned from a provider is posted to the daemon, which keeps it for every
      // program (as the hooks it ran are posted: nobody chose it, so nobody is asked).
      report: (learned) => options.invoke('context.windows.learned.post', {
        program: options.program, model: learned.registryKey, tokens: learned.tokens, outcome: learned.kind === 'accepted' ? 'accepted' : 'refused',
      }),
    })
    : () => {};
  // Models and providers: a model server the daemon finds on this computer reaches this program's model picker and its
  // next turn as soon as the daemon announces it (model-servers-follow.ts).
  const listServers = options.providerRegistry?.listDiscoveredServers?.bind(options.providerRegistry);
  const registerServers = options.providerRegistry?.registerDiscoveredProviders?.bind(options.providerRegistry);
  const stopModelServers = listServers && registerServers
    ? followDaemonModelServers({
      daemonEndpoint: options.daemonEndpoint, onDaemonBack: options.onDaemonBack,
      registry: { listDiscoveredServers: listServers, registerDiscoveredProviders: registerServers },
    })
    : () => {};
  // Permissions and safety: the policy the daemon enforces or restores, and this folder's trust, reach this program's
  // gate as soon as the daemon announces them (policy-follow.ts).
  const followRecord = followSafetyState(options.context);
  const stopPolicy = followRecord
    ? followPolicyInForce({ daemonEndpoint: options.daemonEndpoint, onDaemonBack: options.onDaemonBack, follow: followRecord })
    : () => {};
  // Permissions and safety: the calls this program's gate decides go to the daemon's permission audit, where a
  // candidate policy is reviewed against every program's calls (policy-audit-poster.ts).
  const gateState = (options.context as SafetyStateHolder).extensions?.policyRuntimeState;
  const stopDecidedCalls = gateState?.onDecision
    ? postDecidedCallsToDaemon({ decisions: { onDecision: (listener) => gateState.onDecision!(listener) }, invoke: options.invoke, onDaemonBack: options.onDaemonBack, program: options.program })
    : () => {};
  // Money: the daemon's spending alert over its own runs, said once in this conversation when it passes (spending-alert-follow.ts).
  const stopSpendingAlert = followDaemonSpendingAlert({
    daemonEndpoint: options.daemonEndpoint, onDaemonBack: options.onDaemonBack, invoke: options.invoke,
    say: (text) => { options.context.print(text); options.requestRender(); },
  });
  // Waiting for you: a purchase notice that only tells (OK its one answer) is this program's notice, kept once in its
  // notification history (System, Notices), never a question (purchase-notices-follow.ts).
  const stopPurchaseNotices = followPurchaseNotices({
    daemonEndpoint: options.daemonEndpoint, onDaemonBack: options.onDaemonBack, invoke: options.invoke,
    record: (notice) => {
      options.systemSession?.()?.notices?.record?.(notice);
      options.requestRender();
    },
  });
  // The settings screen: one at a time; opening it again (a /settings line, the System place, the menu) moves it to a target.
  let settingsScreen: SettingsScreen | undefined;
  const openSettings = (target?: string): SettingsTargetOutcome | 'unreported' => {
    const program = options.settings?.();
    const binding = options.capabilityBinding;
    if (!program || !binding) return 'unreported';
    if (!settingsScreen) {
      const screen: SettingsScreen = new SettingsScreen({
        host: wired, context: options.context, binding, program,
        close: (closing) => { options.modals.close(closing); },
        closed: () => { if (settingsScreen === screen) settingsScreen = undefined; },
      });
      settingsScreen = screen;
    }
    options.modals.push(settingsScreen);
    const landed = settingsScreen.selectTarget(target);
    options.requestRender();
    return landed;
  };
  return {
    host: wired,
    openSettings,
    // The menu finds a tab only among the lists this program shows.
    // The daemon counts the places whose lists are all its own in one call, for this program and its project.
    openMenu: () => {
      options.modals.push(new PlaceMenu(PLACES.map((place) => listsHere(place, wired, options.program)), wired, { program: options.program, ...(project ? { workingDirectory: project } : {}) }));
      options.requestRender();
    },
    openPlace,
    stop: () => { stopHeld(); stopHeldSends(); stopHookRuns(); stopNotices(); stopContextWindows(); stopModelServers(); stopPolicy(); stopDecidedCalls(); stopSpendingAlert(); stopPurchaseNotices(); },
    runKey: (action) => {
      if (runSessionsViewKey(wired, action, (line) => { options.context.print(line); options.requestRender(); })) return;
      void runConversationControlKey(wired, action, (line) => { options.context.print(line); options.requestRender(); }, options.program);
    },
  };
}
