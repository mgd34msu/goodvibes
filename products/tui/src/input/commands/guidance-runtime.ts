import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { randomUUID } from 'node:crypto';
import { estimateConversationTokens } from '@goodvibes/engine/platform/platform/core';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines, getGuidanceMode } from '@/runtime/index.ts';
import { dismissGuidance, evaluateContextualGuidance, formatGuidanceItems, resetGuidance } from '@/runtime/index.ts';
import type { GuidancePersistenceOptions, Notification } from '@/runtime/index.ts';
import type { CommandContext } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineList, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import type { ConversationGuidance } from '@goodvibes/engine/platform/platform/capabilities';
import { requireReadModels, requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';

/** Where this app keeps its guidance dismissals. */
function guidanceOptionsFor(ctx: CommandContext): GuidancePersistenceOptions {
  return { homeDirectory: requireShellPaths(ctx).homeDirectory, surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT };
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

/**
 * This app's guidance as the conversation's guidance controls take it (capabilities/builtin/conversation-controls.ts:
 * guidance.review, guidance.dismiss, guidance.reset), run from This conversation's list and by the model.
 */
export function guidanceOf(ctx: CommandContext): ConversationGuidance {
  return {
    async review() {
      const { items, maintenance } = currentGuidance(ctx, guidanceOptionsFor(ctx));
      return [
        `Guidance (${getGuidanceMode(ctx.platform.configManager)})`,
        '',
        ...formatGuidanceItems(items),
        '',
        ...formatSessionMaintenanceLines(maintenance, maintenance.guidanceMode === 'guided' ? 'guided' : 'minimal'),
      ].join('\n');
    },
    async dismiss(id) {
      const options = guidanceOptionsFor(ctx);
      // A dismissal hides the occurrence showing now; the same condition coming back later shows again.
      const item = currentGuidance(ctx, options).items.find((candidate) => candidate.id === id);
      if (!item) throw commandRefusal(`Guidance ${id} is not showing now, so there is nothing to dismiss.`, 'See guidance for now, in This conversation, lists what is.');
      if (!dismissGuidance(item, options)) throw commandRefusal(`The dismissal of ${id} could not be saved: the guidance store is busy or unreadable. Nothing was changed; try again.`);
      return `Dismissed ${id} for what it reports now. It shows again for a new occurrence: another approval, session, provider or server set.`;
    },
    async reset(id) {
      if (!resetGuidance(id || undefined, guidanceOptionsFor(ctx))) throw commandRefusal('Guidance could not be reset: the guidance store is busy or unreadable. Nothing was changed; try again.');
      return id ? `${id} shows again when it applies.` : 'Every dismissed piece of guidance shows again when it applies.';
    },
  };
}

/** The turn events the guidance notices listen to. */
export interface GuidanceNoticeTurnEvents {
  on(event: 'TURN_COMPLETED', handler: () => void): () => void;
}

/**
 * Push each new guidance occurrence into the notification history (counted
 * on the status bar) once, at the end of a turn, so the owner is
 * told without opening This conversation. An occurrence already announced is not
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
      // Guidance is advisory; a read that fails here is shown by guidance.review itself.
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
        body: `${item.summary}${item.commands.length > 0 ? ` Next: ${item.commands.join('  ')}` : ''} (dismiss it from This conversation, in the menu)`,
        timestamp: Date.now(),
      });
    }
    announced.clear();
    for (const key of current) announced.add(key);
  });
}


/** The guidance showing now (`guidance.current` in capabilities/builtin/conversation-controls.ts). */
export const CURRENT_GUIDANCE = defineList<CommandContext>({
  name: 'guidance.current',
  async read(ctx) {
    return currentGuidance(ctx, guidanceOptionsFor(ctx)).items.map((item): ListRow => ({ value: item.id, label: item.title, detail: item.summary }));
  },
  operator: { terminalOnly: 'Guidance reads this terminal\'s session.' },
});
