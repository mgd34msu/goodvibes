import { randomUUID } from 'node:crypto';
import { estimateConversationTokens } from '@goodvibes-jev/engine/platform/platform/core';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines, getGuidanceMode } from '@/runtime/index.ts';
import { dismissGuidance, evaluateContextualGuidance, formatGuidanceItems, resetGuidance } from '@/runtime/index.ts';
import type { GuidancePersistenceOptions, Notification } from '@/runtime/index.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { requireReadModels, requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';

/** Where this app keeps its guidance dismissals. */
function guidanceOptionsFor(ctx: CommandContext): GuidancePersistenceOptions {
  return { homeDirectory: requireShellPaths(ctx).homeDirectory, surfaceRoot: 'tui' };
}

/**
 * The guidance items active now, with the maintenance reading they were built
 * from. `contextTokens` is a count the caller already holds (the last turn's
 * input tokens); without one the conversation is estimated.
 */
function currentGuidance(ctx: CommandContext, guidanceOptions: GuidancePersistenceOptions, contextTokens?: number) {
  const llmMessages = ctx.session.conversationManager.getMessagesForLLM();
  const readModels = requireReadModels(ctx);
  const session = readModels.session.getSnapshot();
  const intelligence = readModels.intelligence.getSnapshot();
  const mcp = readModels.mcp.getSnapshot();
  const health = readModels.health.getSnapshot();
  const marketplace = readModels.marketplace.getSnapshot();
  const maintenance = evaluateSessionMaintenance({
    configManager: ctx.platform.configManager,
    currentTokens: contextTokens ?? estimateConversationTokens(llmMessages),
    contextWindow: ctx.provider.providerRegistry.getKnownContextWindowForModel(ctx.provider.providerRegistry.getCurrentModel()) ?? 0,
    messageCount: llmMessages.length,
    sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
    session: session.session,
  });
  const authRequiredMcpServers = mcp.servers.filter((server) => server.status === 'auth_required').map((server) => server.name);
  const items = evaluateContextualGuidance(
    ctx.platform.configManager,
    {
      pendingApproval: session.pendingApproval,
      pendingApprovalId: session.pendingApprovalId,
      denialCount: session.denialCount,
      authRequiredMcpCount: authRequiredMcpServers.length,
      authRequiredMcpServers,
      degradedProviderCount: health.providerProblems.length,
      degradedProviders: health.providerProblems,
      intelligenceUnavailable: intelligence.diagnosticsStatus === 'unavailable' && intelligence.symbolSearchStatus === 'unavailable',
      recommendations: marketplace.recommendations,
      sessionId: session.session.id,
    },
    maintenance,
    guidanceOptions,
  );
  return { items, maintenance };
}

export function registerGuidanceRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'guidance',
    title: 'Guidance',
    summary: 'Advice for what is happening now (an approval waiting, a server that needs sign-in, a long conversation), without interrupting the chat',
    group: 'Help',
    report: 'review',
    actions: [
      readAction<CommandContext>({
        id: 'review', label: 'See guidance for now', word: 'review',
        sentence: 'Shows the advice that applies now, with the line that acts on each, and how this session is doing for size.',
        operator: { terminalOnly: 'It reads this terminal\'s session.' },
        async run(_values, ctx) {
          const { items, maintenance } = currentGuidance(ctx, guidanceOptionsFor(ctx));
          return [
            `Guidance (${getGuidanceMode(ctx.platform.configManager)})`,
            '',
            ...formatGuidanceItems(items),
            '',
            ...formatSessionMaintenanceLines(maintenance, maintenance.guidanceMode === 'guided' ? 'guided' : 'minimal'),
          ].join('\n');
        },
      }),
      {
        id: 'dismiss', label: 'Dismiss a piece of guidance', word: 'dismiss',
        inputs: [listInput({ id: 'item', label: 'Guidance', help: 'The guidance showing now', list: CURRENT_GUIDANCE, other: 'a guidance id' })],
        sentence: 'Guidance {item} is hidden for what it reports now; a new occurrence shows again, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'reset',
        operator: { terminalOnly: 'Dismissals are kept by this terminal.' }, example: { item: 'approval-pending' },
        async run(values, ctx) {
          const options = guidanceOptionsFor(ctx);
          // A dismissal hides the occurrence showing now; the same condition coming back later shows again.
          const item = currentGuidance(ctx, options).items.find((candidate) => candidate.id === values.item);
          if (!item) throw commandRefusal(`Guidance ${values.item} is not showing now, so there is nothing to dismiss.`, '/guidance lists what is.');
          if (!dismissGuidance(item, options)) throw commandRefusal(`The dismissal of ${values.item} could not be saved: the guidance store is busy or unreadable. Nothing was changed; try again.`);
          return `Dismissed ${values.item} for what it reports now. It shows again for a new occurrence: another approval, session, provider or server set.`;
        },
      },
      {
        id: 'reset', label: 'Show dismissed guidance again', word: 'reset',
        inputs: [textInput({ id: 'item', label: 'Guidance', help: 'One dismissed piece of guidance, by id', why: 'a guidance id you dismissed', typed: { position: 1 }, optional: { default: '', means: 'every dismissed piece' } })],
        sentence: 'Dismissed guidance {item} shows again when it applies, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'dismiss',
        operator: { terminalOnly: 'Dismissals are kept by this terminal.' }, example: { item: 'approval-pending' },
        async run(values, ctx) {
          if (!resetGuidance(values.item || undefined, guidanceOptionsFor(ctx))) throw commandRefusal('Guidance could not be reset: the guidance store is busy or unreadable. Nothing was changed; try again.');
          return values.item ? `${values.item} shows again when it applies.` : 'Every dismissed piece of guidance shows again when it applies.';
        },
      },
    ],
  }));
}

/** The turn events the guidance notices listen to. */
export interface GuidanceNoticeTurnEvents {
  on(event: 'TURN_COMPLETED', handler: () => void): () => void;
}

/**
 * Push each new guidance occurrence into the notification history (and a
 * toast when the router allows) once, at the end of a turn, so the owner is
 * told without running /guidance. An occurrence already announced is not
 * announced again; one that clears and later comes back is. Dismissed items
 * and guidance mode `off` push nothing, because evaluateContextualGuidance
 * already leaves them out. Cost per finished turn: five read-model snapshots
 * and the session-memory count; the context reading is the turn's own input
 * token count (`contextTokens`), not a new estimate of the conversation, and
 * the dismissal file is read only when some item is active.
 */
export function wireGuidanceNotices(
  ctx: CommandContext,
  turns: GuidanceNoticeTurnEvents,
  dispatch: (notification: Notification) => void,
  contextTokens: () => number,
): () => void {
  const announced = new Set<string>();
  return turns.on('TURN_COMPLETED', () => {
    let items: ReturnType<typeof currentGuidance>['items'];
    try {
      items = currentGuidance(ctx, guidanceOptionsFor(ctx), contextTokens()).items;
    } catch {
      // Guidance is advisory; a read that fails here is shown by /guidance itself.
      return;
    }
    const current = new Set<string>();
    for (const item of items) {
      const key = `${item.id}\u0000${item.occurrence}`;
      current.add(key);
      if (announced.has(key)) continue;
      dispatch({
        id: randomUUID(),
        domain: 'guidance',
        level: item.category === 'recovery' ? 'warning' : 'info',
        title: item.title,
        body: `${item.summary}${item.commands.length > 0 ? ` Next: ${item.commands.join('  ')}` : ''} (dismiss: /guidance dismiss ${item.id})`,
        timestamp: Date.now(),
      });
    }
    announced.clear();
    for (const key of current) announced.add(key);
  });
}


const CURRENT_GUIDANCE = defineList<CommandContext>({
  name: 'guidance.current',
  async read(ctx) {
    return currentGuidance(ctx, guidanceOptionsFor(ctx)).items.map((item): ListRow => ({ value: item.id, label: item.title, detail: item.summary }));
  },
  operator: { terminalOnly: 'Guidance reads this terminal\'s session.' },
});
