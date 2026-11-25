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
import type { AnyPlace } from './place-types.js';
import { AUTOMATION_PLACE } from './automation-place.js';
import { keysProgramActions, keysSource } from './keys-place.js';
import { WAITING_PLACE } from './waiting-place.js';
import { waitingPlaceSources } from './waiting-sources.js';
import { placeKeyContext } from './place-keys.js';
import { bridgeHeldCallsToDaemonInbox } from './held-calls-inbox.js';
import { SESSIONS_PLACE } from './sessions-place.js';
import { MESSAGES_PLACE } from './messages-place.js';
import type { PlaceProgramSource } from './place-host.js';
import {
  SYSTEM_PLACE, setupProgramActions, systemHealthSource, systemNoticesSource, systemReleaseSource, systemSessionSource, type SystemSessionReader,
} from './system-place.js';
import type { SetupPlaceHooks } from '../setup-command.js';
import { WORK_PLACE } from './work-place.js';
import { localTasks } from '../tasks-runtime-commands.js';
import { MEMORY_PLACE } from './memory-place.js';
import { MONEY_PLACE } from './money-place.js';
import { DEVICES_PLACE } from './devices-place.js';
import { CODE_PLACE, codePlacePrograms, codePlaceSources } from './code-place.js';
import { agentsPlaceSources, bindWorkAgentLists } from './work-agents-lists.js';
import { TOOLS_PLACE } from './tools-place.js';
import { bindToolsSkillsLists } from './tools-skills-lists.js';
import { bindMemoryStoreLists } from './memory-stores-lists.js';
import { postHookRunsToDaemon, type HookRunsSource } from './hook-runs-poster.js';
import { toolsPlaceSource } from '../tools-capabilities.js';
import { mcpServersPlaceSource, type McpCommandContext } from '../mcp-runtime-commands.js';
import { bindPluginLists } from '../plugin-trust-command.js';
import { CONVERSATION_PLACE, conversationComposerKeyContext, conversationPlaceSources, runConversationControlKey } from './conversation-place.js';
import { followDaemonContextWindows } from '../context-windows-follow.js';
// Models and providers: models, providers and sign-ins, routing, services, media providers, moving them (models-place.ts).
import { MODELS_PLACE } from './models-place.js';
export { MODELS_PLACE } from './models-place.js';
import { SAFETY_PLACE, safetyPlaceSources } from './safety-place.js';

// Permissions and safety: rules, secrets, this folder's trust, sign-in, who is who, tokens, grants, sandbox sessions (safety-place.ts).
export { SAFETY_PLACE, safetyPlaceSources } from './safety-place.js';

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
export const PLACES: readonly AnyPlace[] = [WAITING_PLACE, AUTOMATION_PLACE, SYSTEM_PLACE, SESSIONS_PLACE, MESSAGES_PLACE, WORK_PLACE, MONEY_PLACE, DEVICES_PLACE, CODE_PLACE, TOOLS_PLACE, CONVERSATION_PLACE, SAFETY_PLACE, MEMORY_PLACE, MODELS_PLACE];

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
  /** This program's provider registry: it reads the daemon's context window sizes again on each change (context-windows-follow.ts). */
  readonly providerRegistry?: { contextWindowsChanged(): void } | undefined;
};

export interface WiredPlaces {
  readonly host: PlaceHost;
  /** Open the menu of every place. */
  openMenu(): void;
  /** Open one place by id, on its list `start.list` when given; false when there is none by that id. */
  openPlace(id: string, start?: { readonly list?: string | undefined }): boolean;
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
  // This conversation's controls as keys read while writing a message, none bound until a person binds one.
  options.keys.registerContext(conversationComposerKeyContext());
  // The remote runners' forms read the daemon's runners through this program's binding.
  if (options.capabilityBinding) bindWorkAgentLists(options.capabilityBinding);
  // The skills, bundles, presets and managed applies a form chooses from are the daemon's (tools-skills-entries.ts).
  if (options.capabilityBinding) bindToolsSkillsLists(options.capabilityBinding);
  // The notes, personas, routines, drafts and artifacts a form chooses from are the daemon's (memory-stores-entries.ts).
  if (options.capabilityBinding) bindMemoryStoreLists(options.capabilityBinding);
  // Tools and extensions: the plugin lists a form picks from read the daemon through this program's binding.
  if (options.capabilityBinding) bindPluginLists(options.capabilityBinding);
  const checklist = checklistSource(options.context);
  // Code and changes reads this program's own project folder, through its session capabilities' services.
  const code = (): ReturnType<NonNullable<PlaceHostOptions['sessionServices']>>['code'] => options.sessionServices?.().code;
  const sources = { ...(options.sources ?? {}), keys: keysSource(options.keys), ...(options.setup ? { setup: options.setup.source } : {}),
    ...(options.systemSession ? { 'system-session': systemSessionSource(options.systemSession) } : {}), ...(checklist ? { checklist } : {}),
    // System: this program's health and start, its notices, and (the terminal app's) release readiness (system-place.ts).
    ...(options.systemSession ? {
      'system-health': systemHealthSource(options.systemSession), 'system-notices': systemNoticesSource(options.systemSession),
      ...(options.program === 'tui' ? { 'system-release': systemReleaseSource(options.systemSession) } : {}),
    } : {}), 'tasks-here': tasksHereSource(options.context), ...codePlaceSources(code),
    // Tools and extensions: the tools this program's model can call, through its session capabilities' services.
    tools: toolsPlaceSource(() => options.sessionServices?.().toolRegistry),
    // Tools and extensions: this program's own tool server connections (mcp-runtime-commands.ts).
    'mcp.servers': mcpServersPlaceSource(() => options.context as McpCommandContext),
    // This conversation: its controls, with what each acts on now, through its session capabilities' services.
    ...conversationPlaceSources(options.sessionServices, options.keys, options.program),
    // Permissions and safety: this conversation's permissions and plan mode, and the sandbox sessions this program started.
    ...safetyPlaceSources(options.sessionServices),
    // Waiting for you: the kinds of approval, and (in the Agent) the sends its content check refused.
    ...waitingPlaceSources(options.program),
    // Work and agents: the agents this program started, its work contracts and the archetypes (the terminal app's).
    ...agentsPlaceSources(options.sessionServices, options.agentChanges) };
  let host: PlaceHost | undefined;
  const openPlace = (id: string, start?: { readonly list?: string | undefined }): boolean => {
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
  // The hooks this program runs go to the daemon's one hook trace, beside every other program's.
  let project: string | undefined;
  try { project = options.capabilityBinding?.caller(options.context as never).workingDirectory; } catch { project = undefined; }
  const stopHookRuns = options.hookRuns
    ? postHookRunsToDaemon({ runs: options.hookRuns, invoke: options.invoke, onDaemonBack: options.onDaemonBack, program: options.program, ...(project ? { project } : {}) })
    : () => {};
  // This conversation: a context window size set or cleared through the daemon reaches this program's next turn.
  const stopContextWindows = options.providerRegistry
    ? followDaemonContextWindows({ daemonEndpoint: options.daemonEndpoint, onDaemonBack: options.onDaemonBack, registry: options.providerRegistry })
    : () => {};
  return {
    host: wired,
    // The menu finds a tab only among the lists this program shows.
    openMenu: () => { options.modals.push(new PlaceMenu(PLACES.map((place) => listsHere(place, wired, options.program)), wired)); options.requestRender(); },
    openPlace,
    stop: () => { stopHeld(); stopHookRuns(); stopContextWindows(); },
    runKey: (action) => {
      void runConversationControlKey(wired, action, (line) => { options.context.print(line); options.requestRender(); }, options.program);
    },
  };
}
