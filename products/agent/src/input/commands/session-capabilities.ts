/**
 * The Agent's live conversation, as the conversation capabilities
 * (capabilities/builtin/conversation.ts) take it: the same services for the
 * person's `/clear`, `/compact` and `/undo` and for the model's
 * `capability_run`. The Agent has no rewind to undo.
 */
import type { SessionCapabilityServices } from '@goodvibes/engine/terminal-shell/agent-turn/capability-tools';
import { tasksServices } from '@goodvibes/engine/terminal-shell/tasks-runtime-commands';
import { workIntakeServices } from '@goodvibes/engine/terminal-shell/native/work-command';
import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { agentStatusText } from './status-runtime.ts';
import { switchAlwaysSpeak } from '@goodvibes/engine/terminal-shell/tts-runtime-commands';
import { refuseWhileTurnRuns } from '@goodvibes/engine/terminal-shell/everyday-commands';
import { NOTHING_TO_COMPACT_YET, NothingToCompactError } from '@goodvibes/engine/platform/platform/core';
import { keysServices } from '@goodvibes/engine/terminal-shell/keys-capabilities';
import { hooksReloadServices } from '@goodvibes/engine/terminal-shell/hooks-command';
import { toolRegistryServices } from '@goodvibes/engine/terminal-shell/tools-capabilities';
import { mcpLiveServices } from '@goodvibes/engine/terminal-shell/mcp-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { compactConversation } from './runtime-services.ts';
import { publishNotice } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../core/notifications-feed.ts';
import { liveSessions } from './session.ts';
import { agentOwnerInbox } from '../../runtime/client/owner-questions.ts';
import { CapabilityRefusal, type ConversationControlServices, type PinnedLinesServices, type RoutineStartServices, type StartedRoutine } from '@goodvibes/engine/platform/platform/capabilities';
import { runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { requireReadModels, requireSubscriptionManager } from './runtime-services.ts';
import { securityHereServices } from '@goodvibes/engine/terminal-shell/places';
import { capabilityBinding } from './capability-binding.ts';
import { composerOf, queueOf, turnsOf } from '@goodvibes/engine/terminal-shell/conversation-controls';
import { conversationContextOf } from '@goodvibes/engine/terminal-shell/context-inspection-command';
import { checkpointsOf } from '@goodvibes/engine/terminal-shell/checkpoint-command';
import { effortOf } from '@goodvibes/engine/terminal-shell/model-command';
import { conversationRecord } from './session.ts';
import { contextInspectionPolicy } from './operator-runtime.ts';
import { localActions } from './local-runtime.ts';
import { checkpointPolicy } from './session-content.ts';
import { codeOf } from './code-runtime.ts';
import { permissionsHereOf } from '@goodvibes/engine/terminal-shell/permissions-command';
import { secretsSessionServices } from '@goodvibes/engine/terminal-shell/secrets-command';
import { agentPermissionsDeps } from './permissions-runtime.ts';
import { memorySessionServices } from '@goodvibes/engine/terminal-shell/memory-command';
import { templateSessionServices } from '@goodvibes/engine/terminal-shell/template-session';
import { formatAgentOperatorBriefing } from './brief-runtime.ts';
import { pairingServices } from '@goodvibes/engine/terminal-shell/devices-command';
import { AGENT_PAIRING } from './devices-runtime.ts';
import { healthServicesOf } from '@goodvibes/engine/terminal-shell/health-command';
import { healthPolicy } from './health-runtime.ts';
import { voiceWakeOf } from './experience-runtime.ts';
import { helpServicesOf } from './shell-core.ts';
import { setupTopicsOf } from './onboarding-runtime.ts';
import { writeSetting, type SettingWriteContext } from '@goodvibes/engine/terminal-shell/settings-writes';

export function conversationOf(ctx: CommandContext): SessionCapabilityServices['conversation'] {
  return {
    isGenerating: () => ctx.isGenerating?.() === true,
    messageCount: () => ctx.session.conversationManager.getMessagesForLLM().length,
    startFresh: () => {
      const result = startFreshConversation(ctx);
      // A notice (the status bar's count, ctrl+n), never a row: a row would retire the empty conversation's splash.
      if (result.savedAs) void publishNotice(getSharedNotificationFeed(), '[Session] Fresh conversation. The previous one is saved as ' + result.savedAs + ': /resume ' + result.savedAs + ' returns to it.');
      ctx.renderRequest();
      return result;
    },
    compact: async () => {
      refuseWhileTurnRuns(ctx, '/compact');
      ctx.print('Compacting conversation...');
      const receipt = await compactConversation(ctx);
      if (!receipt) throw new NothingToCompactError(NOTHING_TO_COMPACT_YET);
      ctx.renderRequest();
      return `Conversation compacted (${receipt.messagesBefore} to ${receipt.messagesAfter} messages).`;
    },
    undoTurn: () => {
      const undone = ctx.session.conversationManager.undo();
      if (undone) ctx.renderRequest();
      return undone;
    },
  };
}

/** Everything the conversation capabilities need from the Agent's open conversation. */
export function sessionCapabilityServices(ctx: CommandContext): SessionCapabilityServices {
  return {
    conversation: conversationOf(ctx),
    ...(ctx.workspace.fileUndoManager ? { files: ctx.workspace.fileUndoManager } : {}),
    // The key capabilities (builtin/keys.ts) act on this program's key table.
    ...(ctx.workspace.keybindingsManager ? { keys: keysServices(ctx.workspace.keybindingsManager) } : {}),
    // Its saved sessions (builtin/sessions.ts); the Agent joins no hosted session and keeps no branches.
    sessions: liveSessions(ctx),
    // The project's checklist (builtin/checklist.ts): the shared file, as the Agent reads it.
    checklist: ctx.workspace.workPlan,
    // The Agent's tasks and the daemon's (builtin/tasks.ts), read only here.
    tasks: tasksServices(ctx),
    // Asking for work and its journal (builtin/work-intake.ts), through the Agent's link to the host.
    workIntake: workIntakeServices(ctx),
    // A choice on a call Jev decided here is carried out here (builtin/waiting.ts): the Agent's routed owner inbox.
    ...(ctx.workspace.shellPaths ? { ownerInbox: ownerInboxOf(ctx.workspace.shellPaths, ctx) } : {}),
    // Tools and extensions: the Agent's own dispatcher reads the hooks file again, and its tools (builtin/hooks.ts, tools.ts).
    hookFile: hooksReloadServices(ctx).hookFile,
    toolRegistry: toolRegistryServices(ctx.extensions.toolRegistry),
    // Its own tool server connections and its session's settings for them (builtin/mcp.ts).
    mcpLive: mcpLiveServices(ctx),
    // The plugins this Agent runs (builtin/plugins.ts).
    pluginsLive: { manager: ctx.extensions.pluginManager },
    // What the marketplace has that fits this project, ranked by the decision model when one is set (builtin/marketplace.ts).
    ...(ctx.platform.readModels ? { marketplaceRecommend: { recommend: () => ctx.platform.readModels!.marketplace.recommend() } } : {}),
    // The controls on the conversation itself (builtin/conversation-controls.ts).
    ...conversationControlsOf(ctx),
    // System (builtin/system-session.ts): this session at a glance, closing the Agent, how much it prints.
    systemSession: systemSessionOf(ctx),
    // Code and changes (builtin/code.ts): git, worktrees and code lookups on the Agent's project folder.
    code: codeOf(ctx),
    // Memory and knowledge (builtin/routines.ts): a routine started here, its steps sent as the owner's next message
    // (a model's start reads them as its answer: capability_run leaves `send` out).
    ...routineStartServices(ctx),
    // This conversation: the lines pinned in it (builtin/pinned-lines.ts), the program's own session memory store.
    ...pinnedLinesServices(ctx),
    // Memory and knowledge: what the Agent holds, memory files in its project, templates as the next message
    // (builtin/memory-session.ts, templates.ts); the Agent records no per-turn memory and has no views to link to.
    memorySession: memorySessionServices(ctx),
    templateSession: templateSessionServices(ctx),
    // Permissions and safety: this conversation's permissions and a secret for this session (the Agent keeps no plan mode toggle or sandbox sessions).
    permissionsHere: permissionsHereOf(agentPermissionsDeps(ctx)),
    ...secretsSessionServices(),
    // What needs attention, the whole review and risky MCP routes, from the Agent's MCP servers and plugins with the
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
    // Work and agents (builtin/agents.ts `work.brief`): the Agent's briefing of its own state.
    briefing: { read: () => formatAgentOperatorBriefing(ctx) },
    // Work and agents (builtin/research.ts): a question or a page sent to this conversation as the owner's own message
    // (given only for the owner's own press: the model researches in its own turn).
    // The message is the control's words, not the owner's: it does not rename the conversation.
    ...(ctx.invokedByModel !== true && ctx.submitTurn ? { researchConversation: { send: (prompt: string) => {
      ctx.session.conversationManager.leaveTitleFor(prompt);
      ctx.submitTurn!(prompt);
    } } } : {}),
    // Devices and network (builtin/devices-session.ts): pairing on the Agent's screen, and its own credential for its host.
    pairing: pairingServices(AGENT_PAIRING, ctx),
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

/** The Agent itself, as the System capabilities that run here take it. */
export function systemSessionOf(ctx: CommandContext): NonNullable<SessionCapabilityServices['systemSession']> {
  return {
    status: () => agentStatusText(ctx),
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
    // Whether the Agent is working, and its help (builtin/system-program.ts). Release readiness, the start review and
    // the links to views are the terminal app's: the Agent has none, and those capabilities are no control here.
    health: healthServicesOf(healthPolicy, ctx),
    help: helpServicesOf(ctx),
    // What a support folder records of the Agent's integration helpers (System, Support and transfer).
    ...(ctx.extensions.integrationHelpers ? {
      integrationHelpers: () => {
        const review = ctx.extensions.integrationHelpers!.buildReview();
        return { apiFamilies: review.apiFamilies, routes: review.routes };
      },
    } : {}),
    // The notices and notifications this Agent collected: the System place's Notices list.
    notices: {
      list: () => getSharedNotificationFeed().list(), subscribe: (onChange) => getSharedNotificationFeed().subscribe(onChange),
      markSeen: () => { getSharedNotificationFeed().markAllSeen(); },
      record: (notice) => {
        getSharedNotificationFeed().recordNotice({ domain: notice.domain ?? 'payments', title: notice.title, body: notice.body, timestamp: notice.timestamp, eventKey: notice.key, level: 'info' });
      },
    },
    // The setup rows (builtin/system-program.ts setup.<topic>).
    setupTopic: setupTopicsOf(ctx),
  };
}

/**
 * The controls on the Agent's conversation (builtin/conversation-controls.ts): the turn (sending the last message
 * again first takes back the turn it had), its record, what fills its context and how hard its model thinks, the
 * composer and the workspace checkpoints. The Agent keeps no guidance and queues no messages; it has no rewind.
 */
function conversationControlsOf(ctx: CommandContext): Omit<ConversationControlServices, 'conversation' | 'files'> {
  return {
    turns: turnsOf(ctx, { retryRemovesLastTurn: true }),
    record: conversationRecord(ctx),
    context: conversationContextOf(contextInspectionPolicy, ctx, effortOf(ctx)),
    composer: composerOf(ctx, localActions.attachImage),
    queue: queueOf(ctx),
    checkpoints: checkpointsOf(checkpointPolicy, ctx),
  };
}

/** The Agent's owner inbox: the connected host's when reachable, its own otherwise; a decision made here is carried out here. */
function ownerInboxOf(shellPaths: NonNullable<CommandContext['workspace']['shellPaths']>, ctx: CommandContext) {
  return agentOwnerInbox({ configManager: ctx.platform.configManager, homeDirectory: () => shellPaths.homeDirectory, shellPaths });
}
