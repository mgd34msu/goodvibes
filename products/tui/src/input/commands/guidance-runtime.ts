import { randomUUID } from 'node:crypto';
import { estimateConversationTokens } from '@goodvibes-jev/engine/platform/platform/core';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines, getGuidanceMode } from '@/runtime/index.ts';
import { dismissGuidance, evaluateContextualGuidance, formatGuidanceItems, resetGuidance } from '@/runtime/index.ts';
import type { GuidancePersistenceOptions, Notification } from '@/runtime/index.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
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
  registry.register({
    name: 'guidance',
    description: 'Review contextual operational guidance without interrupting the main conversation flow',
    usage: '[review|dismiss <id>|reset [id]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      const guidanceOptions = guidanceOptionsFor(ctx);
      if (sub === 'dismiss') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /guidance dismiss <id>');
          return;
        }
        // A dismissal hides the occurrence showing now; the same condition coming back later shows again.
        const item = currentGuidance(ctx, guidanceOptions).items.find((candidate) => candidate.id === id);
        if (!item) {
          ctx.print(`Guidance item ${id} is not showing now, so there is nothing to dismiss. /guidance lists the items that are.`);
          return;
        }
        if (!dismissGuidance(item, guidanceOptions)) {
          ctx.print(`Could not save the dismissal of guidance item ${id}: the guidance store is busy or unreadable, so nothing was changed. Try again.`);
          return;
        }
        ctx.print(`Dismissed guidance item ${id} for what it reports now. It shows again for a new occurrence: another approval, session, provider or server set.`);
        return;
      }
      if (sub === 'reset') {
        if (!resetGuidance(args[1], guidanceOptions)) {
          ctx.print('Could not reset guidance: the guidance store is busy or unreadable, so nothing was changed. Try again.');
          return;
        }
        ctx.print(args[1] ? `Reset guidance item ${args[1]}.` : 'Reset all dismissed guidance items.');
        return;
      }
      if (sub !== 'review') {
        ctx.print('Usage: /guidance [review|dismiss <id>|reset [id]]');
        return;
      }

      const { items, maintenance } = currentGuidance(ctx, guidanceOptions);
      ctx.print(
        [
          `Guidance Review (${getGuidanceMode(ctx.platform.configManager)})`,
          '',
          ...formatGuidanceItems(items),
          '',
          ...formatSessionMaintenanceLines(maintenance, maintenance.guidanceMode === 'guided' ? 'guided' : 'minimal'),
        ].join('\n'),
      );
    },
  });
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

