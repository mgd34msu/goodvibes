/**
 * `/channels` is one description shared with the Agent
 * (terminal-shell/channels-command.ts). Here the daemon's channel methods go
 * over the operator wire, and this app gives what it keeps itself: the route
 * and delivery snapshots, the integration overview and the routes view.
 * Pairing a channel is "Pair something" under /devices.
 */
import { registerChannelsCommand } from '@goodvibes-jev/engine/terminal-shell/channels-command';
import { openTelegramCursorRecovery } from './telegram-cursor.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireIntegrationHelpers } from './runtime-services.ts';
import { surfaceEnabledInSettings } from './channel-pairing.ts';
import { invokeOperatorMethod } from './operator-rpc.ts';

function snapshotLines(title: string, snapshot: Readonly<Record<string, unknown>>, empty: string): string {
  const entries = Object.entries(snapshot);
  if (entries.length === 0) return empty;
  return [title, ...entries.map(([key, value]) => `  ${String(key).padEnd(28)} ${JSON.stringify(value)}`)].join('\n');
}

export function registerChannelRuntimeCommands(registry: CommandRegistry): void {
  registerChannelsCommand<CommandContext>(registry, {
    invoke: (ctx, method, input) => invokeOperatorMethod(ctx, method, input),
    telegramCursor: (ctx) => openTelegramCursorRecovery(ctx),
    enabledInSettings: (ctx, surface) => surfaceEnabledInSettings(ctx.platform.configManager, surface),
    openView: (ctx) => { ctx.openView?.('routes'); },
    overview(ctx) {
      const review = requireIntegrationHelpers(ctx).buildReview();
      return [
        'What the channels carry:',
        `  routes:            ${review.routes.length}`,
        `  api families:      ${review.apiFamilies.join(', ') || '(none)'}`,
        `  sessions:          ${review.sessions}`,
        `  tasks:             ${review.tasks}`,
        `  waiting approvals: ${review.pendingApprovals}`,
        `  remote contracts:  ${review.remoteContracts}`,
        `  active route families: ${review.routes.join(', ') || '(none)'}`,
      ].join('\n');
    },
    routes: (ctx) => snapshotLines('Active routes:', requireIntegrationHelpers(ctx).getRouteSnapshot(),
      'No route is active. Routes become active when a channel (slack, discord, ntfy, webhook, ...) is set up and the daemon is running.'),
    delivery: (ctx) => snapshotLines('Outbound delivery:', requireIntegrationHelpers(ctx).getDeliverySnapshot(),
      'No delivery snapshot yet; it fills in once the daemon sends a message on a channel.'),
  });
}
