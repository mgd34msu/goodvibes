/**
 * `/channels` is one description shared with the terminal app
 * (terminal-shell/channels-command.ts). Here the daemon's channel methods go to
 * the connected host, and this app gives what it keeps itself: the setup
 * readiness of the channels it can send to, the setup guide, the inbox, sends
 * and their receipts.
 */
import { registerChannelsCommand, type ChannelReadinessFilter, type ChannelSendValues } from '@goodvibes-jev/engine/terminal-shell/channels-command';
import { openTelegramCursorRecovery } from './telegram-cursor.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { AgentWorkspaceChannelSetupGuide, AgentWorkspaceChannelStatus } from '../agent-workspace-channels.ts';
import { buildAgentWorkspaceChannelTriage, formatAgentWorkspaceChannelTriage } from '../agent-workspace-channel-triage.ts';
import { buildAgentWorkspaceChannelSetupGuide, buildAgentWorkspaceChannels } from '../agent-workspace-channels.ts';
import { invokeConnectedHostMethod } from '../connected-host-routes.ts';
import { buildAgentChannelDeliveryPreview, deliverAgentChannelMessage, formatAgentChannelDeliveryResult } from '@goodvibes-jev/engine/terminal-shell/agent-turn/channel-delivery';
import { formatAgentChannelDeliveryReceiptLine, readAgentChannelDeliveryReceipts, recordAgentChannelDeliveryReceipt } from '@goodvibes-jev/engine/terminal-shell/agent-turn/channel-delivery-receipts';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal } from './confirmation.ts';
import { Secret } from '@goodvibes-jev/engine/platform/platform/security';

function readLimitValue(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function formatChannelDeliveryReceipts(context: CommandContext, limitArg?: string): string {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return [
      'Channel Delivery Receipts',
      '  status unavailable',
      '  reason Agent shell paths are unavailable in this runtime.',
    ].join('\n');
  }
  const limit = readLimitValue(limitArg, 10);
  const snapshot = readAgentChannelDeliveryReceipts(shellPaths);
  const receipts = snapshot.receipts.slice(0, limit);
  return [
    'Channel Delivery Receipts',
    `  path ${snapshot.path}`,
    `  total ${snapshot.receipts.length}`,
    `  returned ${receipts.length}`,
    `  status ${snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty'}`,
    ...(snapshot.parseError ? [`  parse error ${snapshot.parseError}`] : []),
    '  policy confirmed sends only; message bodies and secret-bearing target values are bounded or redacted',
    ...receipts.map((receipt) => `  ${formatAgentChannelDeliveryReceiptLine(receipt)}`),
    ...(receipts.length === 0 ? ['  no channel deliveries recorded yet'] : []),
  ].join('\n');
}

function formatChannelLine(channel: AgentWorkspaceChannelStatus): string {
  const missing = channel.missingRequiredKeys.length > 0
    ? ` missing=${channel.missingRequiredKeys.join('|')}`
    : '';
  const target = channel.configuredDefaultTargetKeys.length > 0
    ? ` target=${channel.configuredDefaultTargetKeys.join('|')}`
    : channel.defaultTargetKeys.length > 0
      ? ` target=missing(${channel.defaultTargetKeys.join('|')})`
      : ' target=not-required';
  return [
    `  ${channel.label}: ${channel.setupState}`,
    `ready=${channel.ready ? 'yes' : 'no'}`,
    `delivery=${channel.delivery}`,
    `risk=${channel.risk}`,
    target,
    missing,
  ].join(' ');
}

function filterChannels(
  channels: readonly AgentWorkspaceChannelStatus[],
  filter: ChannelReadinessFilter,
): readonly AgentWorkspaceChannelStatus[] {
  if (filter === 'ready') return channels.filter((channel) => channel.ready);
  if (filter === 'attention') return channels.filter((channel) => (channel.enabled || channel.setupState === 'unknown') && channel.setupState !== 'ready');
  return channels;
}

function formatChannelSummary(
  channels: readonly AgentWorkspaceChannelStatus[],
  filter: ChannelReadinessFilter,
): string {
  const ready = channels.filter((channel) => channel.ready);
  const enabled = channels.filter((channel) => channel.enabled);
  const needsTarget = channels.filter((channel) => channel.setupState === 'needs-target');
  const needsConfig = channels.filter((channel) => channel.setupState === 'needs-config');
  const filtered = filterChannels(channels, filter);
  const title = filter === 'ready'
    ? 'Channel Readiness: Ready'
    : filter === 'attention'
      ? 'Channel Readiness: Needs Attention'
      : 'Channel Readiness';
  const lines: string[] = [
    title,
    `  ready: ${ready.length}/${channels.length}`,
    `  enabled: ${enabled.length}/${channels.length}`,
    `  needs target: ${needsTarget.length}`,
    `  needs config: ${needsConfig.length}`,
    '  policy: read-only inspection; sends require explicit user action and Agent policy',
    '  details: /channels configured <channel>',
    '',
    ...(filtered.length > 0
      ? filtered.map(formatChannelLine)
      : [`  No ${filter === 'ready' ? 'ready' : 'attention'} channels matched.`]),
  ];
  return lines.join('\n');
}

function formatChannelDetail(channel: AgentWorkspaceChannelStatus): string {
  return [
    `Channel: ${channel.label} (${channel.id})`,
    `  state: ${channel.setupState}`,
    `  enabled: ${channel.enabled ? 'yes' : 'no'}`,
    `  ready: ${channel.ready ? 'yes' : 'no'}`,
    `  delivery: ${channel.delivery}`,
    `  risk: ${channel.risk} (${channel.riskLabel})`,
    `  required config keys: ${channel.requiredKeys.join(', ') || 'none'}`,
    `  missing config keys: ${channel.missingRequiredKeys.join(', ') || 'none'}`,
    `  default target keys: ${channel.defaultTargetKeys.join(', ') || 'not required'}`,
    `  configured target keys: ${channel.configuredDefaultTargetKeys.join(', ') || 'none'}`,
    `  next: ${channel.nextStep}`,
    '  policy: this command never prints secret values and never sends messages',
  ].join('\n');
}

function formatGuideStepStatus(status: string): string {
  if (status === 'complete') return '[x]';
  if (status === 'current') return '[>]';
  if (status === 'then') return 'then';
  return '[ ]';
}

function formatChannelSetupGuide(guide: AgentWorkspaceChannelSetupGuide): string {
  const lines = [
    'Channel Setup Guide',
    `  state: ${guide.status}`,
    `  progress: ${guide.progressLabel}`,
    `  current channel: ${guide.currentChannelLabel ?? 'choose a channel'}${guide.currentChannelId ? ` (${guide.currentChannelId})` : ''}`,
    `  summary: ${guide.summary}`,
    `  ready: ${guide.readyChannels}/${guide.totalChannels}; enabled: ${guide.enabledChannels}; attention: ${guide.attentionChannels}; targets: ${guide.configuredTargets}`,
    `  policy: ${guide.policy}`,
    '',
    '  Steps',
  ];
  for (const step of guide.steps) {
    lines.push(`  ${formatGuideStepStatus(step.status)} ${step.label}: ${step.userRoute}`);
    if (step.status === 'current') lines.push(`      next: ${step.detail}`);
  }
  lines.push('', '  Channel order');
  for (const channel of guide.channels.slice(0, 10)) {
    lines.push(`  - ${channel.label}: ${channel.setupState}; ${channel.summary}; guide ${channel.guideRoute}`);
  }
  if (guide.channels.length > 10) lines.push(`  ${guide.channels.length - 10} more channel(s) omitted.`);
  return lines.join('\n');
}


async function sendChannelMessage(ctx: CommandContext, values: ChannelSendValues): Promise<string> {
  const router = ctx.platform.channelDeliveryRouter;
  if (!router) throw commandRefusal('Channel delivery is not available in this Agent runtime.');
  const input = { ...values, ...(values.webhook ? { webhook: Secret.of(values.webhook, '/channels send webhook') } : {}) };
  try {
    buildAgentChannelDeliveryPreview(input);
  } catch (error) {
    throw commandRefusal(error instanceof Error ? error.message : String(error));
  }
  try {
    const result = await deliverAgentChannelMessage(router, input);
    const lines = [formatAgentChannelDeliveryResult(result)];
    if (ctx.workspace?.shellPaths) {
      try {
        const receipt = recordAgentChannelDeliveryReceipt(ctx.workspace.shellPaths, { source: 'command', deliveryInput: input, result });
        lines.push(`  receipt ${receipt.id}`);
        if (receipt.storeNote) lines.push(`  ${receipt.storeNote}`);
      } catch (receiptError) {
        lines.push(`  receipt unavailable ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
      }
    }
    return lines.join('\n');
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Send failed: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}

function findChannel(ctx: CommandContext, id: string): AgentWorkspaceChannelStatus {
  const wanted = id.trim().toLowerCase();
  const channel = buildAgentWorkspaceChannels(ctx).find((entry) => entry.id.toLowerCase() === wanted || entry.label.toLowerCase() === wanted);
  if (!channel) throw commandRefusal(`No channel is called ${id}.`, '/channels readiness lists the channels');
  return channel;
}

export function registerChannelsRuntimeCommands(registry: CommandRegistry): void {
  registerChannelsCommand<CommandContext>(registry, {
    invoke: (ctx, method, input) => invokeConnectedHostMethod(ctx, method, input),
    telegramCursor: (ctx) => openTelegramCursorRecovery(ctx),
    readiness: (ctx, filter: ChannelReadinessFilter) => formatChannelSummary(buildAgentWorkspaceChannels(ctx), filter),
    configured: (ctx, id) => formatChannelDetail(findChannel(ctx, id)),
    guide: (ctx, id) => formatChannelSetupGuide(buildAgentWorkspaceChannelSetupGuide(buildAgentWorkspaceChannels(ctx), id ? { channelId: id } : {})),
    triage: async (ctx, limit) => formatAgentWorkspaceChannelTriage(await buildAgentWorkspaceChannelTriage(ctx, { limit })),
    receipts: (ctx, limit) => formatChannelDeliveryReceipts(ctx, limit),
    send: sendChannelMessage,
  });
}
