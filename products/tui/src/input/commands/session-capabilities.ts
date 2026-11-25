/**
 * The terminal app's live conversation, as the conversation capabilities
 * (capabilities/builtin/conversation.ts) take it: the same services for the
 * person's `/clear`, `/compact` and `/undo` and for the model's
 * `capability_run`.
 */
import type { SessionCapabilityServices } from '@goodvibes/engine/terminal-shell/agent-turn/capability-tools';
import { tasksServices } from '@goodvibes/engine/terminal-shell/tasks-runtime-commands';
import { workIntakeServices } from '@goodvibes/engine/terminal-shell/native/work-command';
import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { switchAlwaysSpeak } from '@goodvibes/engine/terminal-shell/tts-runtime-commands';
import { keysServices } from '@goodvibes/engine/terminal-shell/keys-capabilities';
import { hooksReloadServices } from '@goodvibes/engine/terminal-shell/hooks-command';
import { toolRegistryServices } from '@goodvibes/engine/terminal-shell/tools-capabilities';
import { mcpLiveServices } from '@goodvibes/engine/terminal-shell/mcp-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { CompactBusyError, compactConversation } from './runtime-services.ts';
import { redoLastRewind, undoLastRewind } from './rewind-runtime.ts';
import { CapabilityRefusal, type ConversationControlServices, type PinnedLinesServices, type RoutineStartServices, type StartedRoutine } from '@goodvibes/engine/platform/platform/capabilities';
import { runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { composerOf, queueOf, turnsOf } from '@goodvibes/engine/terminal-shell/conversation-controls';
import { conversationContextOf } from '@goodvibes/engine/terminal-shell/context-inspection-command';
import { checkpointsOf } from '@goodvibes/engine/terminal-shell/checkpoint-command';
import { effortOf } from '@goodvibes/engine/terminal-shell/model-command';
import { conversationRecord } from './session.ts';
import { contextInspectionPolicy } from './operator-runtime.ts';
import { guidanceOf } from './guidance-runtime.ts';
import { localActions } from './local-runtime.ts';
import { checkpointPolicy } from './checkpoint-runtime.ts';
import { buildCompactionAfterNotice, buildCompactionPreview } from '../../renderer/compaction-preview.ts';
import { publishNotice } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../views/notifications-feed.ts';
import { liveSessions } from './session.ts';
import { hostedJoinOf, hostedToolStopOf } from './hosted-runtime.ts';
import { terminalOwnerInbox } from '../../runtime/client/owner-questions.ts';
import { codeOf } from './code-runtime.ts';
import { permissionsHereOf } from '@goodvibes/engine/terminal-shell/permissions-command';
import { secretsSessionServices } from '@goodvibes/engine/terminal-shell/secrets-command';
import { permissionsDeps } from './permissions-runtime.ts';
import { planModeServices } from './planning-runtime.ts';
import { requireReadModels, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { securityHereServices } from '@goodvibes/engine/terminal-shell/places';
import { capabilityBinding } from './capability-binding.ts';
import { serviceSessionsOf } from './platform-access-runtime.ts';
import { pairingServices } from '@goodvibes/engine/terminal-shell/devices-command';
import { TUI_PAIRING } from './devices-runtime.ts';
import { memorySessionServices } from '@goodvibes/engine/terminal-shell/memory-command';
import { templateSessionServices } from '@goodvibes/engine/terminal-shell/template-session';
import { deepLinksOf, integrationHelpersOf, viewLinkFileOf } from './platform-services-runtime.ts';
import { teamHost } from './teamwork-runtime.ts';
import { contractsHost } from './control-room-runtime.ts';
import { evalSuitesOf } from './eval.ts';
import { healthServicesOf } from '@goodvibes/engine/terminal-shell/health-command';
import { healthPolicy } from './health-runtime.ts';
import { releaseOf } from './product-runtime.ts';
import { startupOf } from './local-setup.ts';
import { voiceWakeOf } from './experience-runtime.ts';
import { helpServicesOf } from './shell-core.ts';
import { DEEP_LINK_SURFACES, buildDeepLink } from './deep-link.ts';
import { setupTopicsOf } from './onboarding-runtime.ts';
import { writeSetting, type SettingWriteContext } from '@goodvibes/engine/terminal-shell/settings-writes';

/** Work and agents (builtin/agents.ts): this app's team modes, recipes and archetypes, bound to this conversation. */
function agentTeamOf(ctx: CommandContext): NonNullable<SessionCapabilityServices['agentTeam']> {
  const team = teamHost();
  return {
    review: () => team.review(ctx), archetypes: () => team.archetypes(ctx), archetypeReport: (name) => team.archetypeReport(ctx, name),
    startMode: (mode, title) => team.startMode(ctx, mode, title), runRecipe: (recipe, title) => team.runRecipe(ctx, recipe, title),
    startArchetype: (name, title) => team.startArchetype(ctx, name, title),
  };
}

/** Work and agents (builtin/agents.ts): the agents this app started, and stopping them. */
function agentContractsOf(ctx: CommandContext): NonNullable<SessionCapabilityServices['agentContracts']> {
  const contracts = contractsHost();
  return {
    running: () => contracts.running(ctx), started: () => contracts.started(ctx),
    stop: (id, note) => contracts.stop(ctx, id, note),
    stopGroup: (id) => contracts.stopGroup(ctx, id), stopBranch: (id) => contracts.stopBranch(ctx, id),
  };
}

/** `/compact`'s own compaction: the preview, then what happened, in words. */
export async function compactInWords(ctx: CommandContext): Promise<string> {
  const messages = ctx.session.conversationManager.getMessagesForLLM();
  // 0 when the window is unknown: the preview then leaves out the capacity clause.
  const contextWindow = ctx.provider.providerRegistry.getKnownContextWindowForModel(ctx.provider.providerRegistry.getCurrentModel()) ?? 0;
  const memStore = ctx.session.sessionMemoryStore;
  const pinnedMemoryCount = memStore ? memStore.list().length : 0;
  // Pre-compact preview: honest estimate, clearly labelled.
  ctx.print(buildCompactionPreview({ messages, contextWindow, pinnedMemoryCount, trigger: 'manual' }));
  let result: Awaited<ReturnType<typeof compactConversation>>;
  try {
    result = await compactConversation(ctx);
  } catch (error) {
    if (!(error instanceof CompactBusyError)) throw error;
    return error.message;
  }
  if (result.kind === 'summarised') return buildCompactionAfterNotice({ event: result.event, pinnedMemoryCount, qualityScore: result.qualityScore });
  if (result.kind === 'dropped') return `[Context] Dropped the ${result.dropped} oldest message(s) without a summary and kept the last ${result.kept}: this model's context window is too small to summarise them. Their tool results are gone; re-read any file you still need. "See what compaction removed", in This conversation, lists it.`;
  return `[Context] Nothing was compacted: ${result.reason}.`;
}

export function conversationOf(ctx: CommandContext): SessionCapabilityServices['conversation'] {
  return {
    isGenerating: () => ctx.isGenerating?.() === true,
    messageCount: () => ctx.session.conversationManager.getMessagesForLLM().length,
    startFresh: () => {
      const result = startFreshConversation(ctx);
      // A notice (the status bar's count, ctrl+n), never a row: a row would retire the empty conversation's splash.
      if (result.savedAs) publishNotice(getSharedNotificationFeed(), '[Session] Fresh conversation. The previous one is saved as ' + result.savedAs + ': /resume ' + result.savedAs + ' returns to it.');
      ctx.renderRequest();
      return result;
    },
    compact: async () => {
      const words = await compactInWords(ctx);
      ctx.renderRequest();
      return words;
    },
    undoTurn: () => {
      const undone = ctx.session.conversationManager.undo();
      if (undone) ctx.renderRequest();
      return undone;
    },
  };
}

/** Everything the conversation capabilities need from this app's open conversation. */
export function sessionCapabilityServices(ctx: CommandContext): SessionCapabilityServices {
  return {
    conversation: conversationOf(ctx),
    ...(ctx.workspace.fileUndoManager ? { files: ctx.workspace.fileUndoManager } : {}),
    // The key capabilities (builtin/keys.ts) act on this program's key table.
    ...(ctx.workspace.keybindingsManager ? { keys: keysServices(ctx.workspace.keybindingsManager) } : {}),
    // Its saved sessions and branches, and the hosted session it joined (builtin/sessions.ts).
    sessions: liveSessions(ctx),
    hostedJoin: hostedJoinOf(ctx),
    // The project's checklist (builtin/checklist.ts): the shared file, as this app reads it.
    checklist: ctx.workspace.workPlan,
    // This app's tasks and the daemon's (builtin/tasks.ts), through its task policy.
    tasks: tasksServices(ctx),
    // Asking for work and its journal (builtin/work-intake.ts), through this app's link to the host.
    workIntake: workIntakeServices(ctx),
    // A choice on a call Jev decided here is carried out here (builtin/waiting.ts): this app's routed owner inbox.
    ...(ctx.workspace.shellPaths ? { ownerInbox: ownerInboxOf(ctx.workspace.shellPaths, ctx) } : {}),
    // Tools and extensions: this app's own dispatcher reads the hooks file again, and its tools (builtin/hooks.ts, tools.ts).
    hookFile: hooksReloadServices(ctx).hookFile,
    toolRegistry: toolRegistryServices(ctx.extensions.toolRegistry),
    // Its own tool server connections and its session's settings for them (builtin/mcp.ts).
    mcpLive: mcpLiveServices(ctx),
    // The plugins this app runs (builtin/plugins.ts).
    pluginsLive: { manager: ctx.extensions.pluginManager },
    // What the marketplace has that fits this project, ranked by the decision model when one is set (builtin/marketplace.ts).
    ...(ctx.platform.readModels ? { marketplaceRecommend: { recommend: () => ctx.platform.readModels!.marketplace.recommend() } } : {}),
    // Its helper interfaces, its view links saved to a file, the tool running in the hosted session it joined (builtin/tools-extras.ts).
    ...(integrationHelpersOf(ctx) ? { integrationHelpers: integrationHelpersOf(ctx) } : {}),
    viewLinkFile: viewLinkFileOf(ctx),
    hostedToolStop: hostedToolStopOf(ctx),
    // The controls on the conversation itself (builtin/conversation-controls.ts).
    ...conversationControlsOf(ctx),
    // Work and agents: the runs this app recorded of its turns (builtin/replay.ts).
    ...(ctx.platform.replayEngine ? { replay: { engine: ctx.platform.replayEngine } } : {}),
    // Work and agents: this app's own agents, started from team modes, recipes and archetypes, and their contracts (builtin/agents.ts).
    agentTeam: agentTeamOf(ctx),
    agentContracts: agentContractsOf(ctx),
    // Work and agents: task suites run in this app's project, and their results this session (builtin/eval.ts).
    evalSuites: evalSuitesOf(ctx),
    // System (builtin/system-session.ts): this session at a glance, closing this app, how much it prints.
    systemSession: systemSessionOf(ctx),
    // Code and changes (builtin/code.ts): git, worktrees, the code index, code lookups and tests on this app's project folder.
    code: codeOf(ctx),
    // Memory and knowledge: this app's turn record and what it holds, memory files in its project, templates as the next
    // message, links to its views (builtin/memory-session.ts, templates.ts, deeplink.ts).
    memorySession: memorySessionServices(ctx),
    templateSession: templateSessionServices(ctx),
    deepLinks: deepLinksOf(ctx),
    // Permissions and safety: this conversation's permissions and plan mode, a secret for this session, its sandbox sessions.
    permissionsHere: permissionsHereOf(permissionsDeps(ctx)),
    ...planModeServices(ctx),
    ...secretsSessionServices(),
    ...(ctx.workspace.sandboxSessionRegistry ? {
      sandboxSessions: {
        registry: ctx.workspace.sandboxSessionRegistry,
        config: { get: (key: string) => ctx.platform.configManager.get(key as ConfigKey) },
        resolvePath: (path: string) => requireShellPaths(ctx).resolveWorkspacePath(path),
        // A model writes a record only inside the working folder.
        insideOnly: ctx.invokedByModel === true,
      },
    } : {}),
    // What needs attention, the whole review and risky MCP routes, from this app's MCP servers and plugins with the
    // daemon's facts, and the sandbox probe on this terminal (builtin/security-review.ts).
    ...securityHereServices(ctx, capabilityBinding, {
      mcp: () => {
        const snapshot = requireReadModels(ctx).security.getSnapshot();
        return { servers: snapshot.mcpServers, recentDecisions: snapshot.recentMcpDecisions };
      },
      plugins: () => ctx.extensions.pluginManager?.list() ?? [],
      subscriptions: () => {
        const subscriptions = requireSubscriptionManager(ctx);
        return { active: subscriptions.list().length, pending: subscriptions.listPending().length };
      },
      sandboxConfig: { get: (key: string) => ctx.platform.configManager.get(key as ConfigKey) },
    }),
    // Memory and knowledge (builtin/routines.ts): a routine started here, its steps sent as the owner's next message
    // (a model's start reads them as its answer: capability_run leaves `send` out).
    ...routineStartServices(ctx),
    // This conversation: the lines pinned in it (builtin/pinned-lines.ts), the program's own session memory store.
    ...pinnedLinesServices(ctx),
    // Models and providers (builtin/service-sessions.ts): this terminal's own sign-in to a daemon or listener.
    serviceSessions: serviceSessionsOf(ctx),
    // Devices and network (builtin/devices-session.ts): pairing on this terminal's screen, and its own credential for its daemon.
    pairing: pairingServices(TUI_PAIRING, ctx),
  };
}

/**
 * Starting a routine in this conversation (builtin/routines.ts): the routine marked started in the owner's routine
 * store, and its steps sent as the owner's next message (`send`, given only for the owner's own press or line).
 */
/** The lines pinned in this conversation (`!#` / `#`), as This conversation lists, changes and removes them. */
export function pinnedLinesServices(ctx: CommandContext): PinnedLinesServices {
  const store = ctx.session.sessionMemoryStore;
  if (!store) return {};
  return {
    pinned: {
      list: () => store.list().map((line) => ({ id: line.id, text: line.text, createdAt: line.createdAt })),
      change: (id, text) => { const changed = store.update(id, text); if (changed) ctx.renderRequest(); return changed; },
      remove: (id) => { const removed = store.remove(id); if (removed) ctx.renderRequest(); return removed; },
    },
  };
}

export function routineStartServices(ctx: CommandContext): RoutineStartServices {
  return {
    // Counted by the daemon, the one count every program shows; its steps come back to run here.
    routines: {
      start: async (routine) => {
        const answer = await runDaemonCapability('routines.count-start', { routine }, ctx, capabilityBinding);
        const started = (answer.data as { readonly routine?: StartedRoutine } | undefined)?.routine;
        if (!started) throw new CapabilityRefusal(`Not started: the daemon did not give back routine ${routine}'s steps.`);
        return started;
      },
    },
    ...(ctx.invokedByModel !== true && ctx.submitTurn ? { send: (message: string) => { ctx.submitTurn!(message); } } : {}),
  };
}

/** This app itself, as the System capabilities that run here take it. */
export function systemSessionOf(ctx: CommandContext): NonNullable<SessionCapabilityServices['systemSession']> {
  return {
    status: () => {
      if (ctx.describeStatus) return ctx.describeStatus();
      // A run with no screen (headless): the run's real state, from what it holds.
      const config = ctx.platform.configManager;
      const runtime = ctx.session.runtime;
      const daemonUrl = String(config.get('daemon.connectedHost.url' as ConfigKey) ?? '').trim();
      return [
        'Status',
        `  model        ${runtime.model ? `${runtime.model} (${runtime.provider})` : 'none chosen'}`,
        `  mode         ${String(config.get('permissions.mode' as ConfigKey) ?? '')}`,
        `  folder       ${ctx.workspace.shellPaths?.workingDirectory ?? 'not known'}`,
        `  daemon       ${daemonUrl || 'this computer\'s daemon'}`,
        '  run          headless (no screen)',
      ].join('\n');
    },
    quit: () => { ctx.exit(); },
    ...(ctx.ops.modeManager ? { printLevel: ctx.ops.modeManager } : {}),
    // Through the daemon's settings.set (settings-writes.ts); a refusal is said there.
    savePrintLevel: (level) => { void writeSetting(ctx as unknown as SettingWriteContext, 'behavior.hitlMode', level).catch(() => {}); },
    redraw: () => { ctx.renderRequest(); },
    // Speaking answers aloud and listening for the wake word, on this terminal.
    speech: {
      alwaysSpeaks: () => Boolean(ctx.platform.configManager.get('ui.voiceEnabled')),
      setAlwaysSpeak: (on) => switchAlwaysSpeak(ctx, on),
      ...(ctx.submitSpokenInput ? { speak: (prompt: string) => { ctx.submitSpokenInput?.(prompt); } } : {}),
      ...(ctx.listenForWakeAgain ? { listenAgain: () => ctx.listenForWakeAgain!() } : {}),
      ...(ctx.stopSpokenOutput ? { stop: () => (ctx.stopSpokenOutput!() as unknown) !== false } : {}),
      wake: voiceWakeOf(ctx),
    },
    // Whether this app is working, release readiness, its own start, links to its views, its help (builtin/system-program.ts).
    health: healthServicesOf(healthPolicy, ctx),
    release: releaseOf(ctx),
    startup: startupOf(ctx),
    viewLinks: () => DEEP_LINK_SURFACES.map((surface) => buildDeepLink(surface)),
    // What a support folder records of this app's integration helpers (System, Support and transfer).
    ...(ctx.extensions.integrationHelpers ? {
      integrationHelpers: () => {
        const review = ctx.extensions.integrationHelpers!.buildReview();
        return { apiFamilies: review.apiFamilies, routes: review.routes };
      },
    } : {}),
    // The notices and notifications this app collected: the System place's Notices list.
    notices: {
      list: () => getSharedNotificationFeed().list(), subscribe: (onChange) => getSharedNotificationFeed().subscribe(onChange),
      markSeen: () => { getSharedNotificationFeed().markAllSeen(); },
      record: (notice) => {
        getSharedNotificationFeed().recordNotice({ domain: notice.domain ?? 'payments', title: notice.title, body: notice.body, timestamp: notice.timestamp, eventKey: notice.key, level: 'info' });
      },
    },
    help: helpServicesOf(ctx),
    // The setup forms (builtin/system-program.ts setup.<topic>).
    setupTopic: setupTopicsOf(ctx),
  };
}

/**
 * The controls on this app's conversation (builtin/conversation-controls.ts): the turn, its record, what fills its
 * context and how hard its model thinks, its guidance, the composer and its queue, and the workspace checkpoints.
 * The rewind here also redoes the one undone last.
 */
function conversationControlsOf(ctx: CommandContext): Omit<ConversationControlServices, 'conversation' | 'files'> {
  return {
    rewind: { undo: async () => (await undoLastRewind(ctx)).message, redo: async () => (await redoLastRewind(ctx)).message },
    turns: turnsOf(ctx, { retryRemovesLastTurn: false }),
    record: conversationRecord(ctx),
    context: conversationContextOf(contextInspectionPolicy, ctx, effortOf(ctx)),
    guidance: guidanceOf(ctx),
    composer: composerOf(ctx, localActions.attachImage),
    queue: queueOf(ctx),
    checkpoints: checkpointsOf(checkpointPolicy, ctx),
  };
}

/** This app's owner inbox: the daemon's when reachable, the home store otherwise; a decision made here is carried out here. */
function ownerInboxOf(shellPaths: NonNullable<CommandContext['workspace']['shellPaths']>, ctx: CommandContext) {
  return terminalOwnerInbox({ configManager: ctx.platform.configManager, homeDirectory: () => shellPaths.homeDirectory, shellPaths });
}
