/**
 * checkin-runtime.ts
 *
 * `/checkin`, the proactive check-in surface: config (enabled/cadence/
 * delivery channel/quiet hours) and its receipt trail, over the operator
 * wire (see operator-rpc.ts for why this goes over HTTP rather than the
 * in-process OperatorClient facade). Off by default; every run, scheduled
 * or manual, leaves a receipt (`checkin.receipts.list`) recording whether it
 * stayed quiet, delivered a message, or was skipped, so the config surface
 * in /settings's Automation group is never the only place this feature's
 * behavior is visible.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { readAction } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';

type CheckinConfig = OperatorMethodOutput<'checkin.config.get'>['config'];
type CheckinReceipt = OperatorMethodOutput<'checkin.receipts.list'>['receipts'][number];

export function renderConfig(config: CheckinConfig): string {
  return [
    'Check-in config:',
    `  enabled:         ${config.enabled ? 'yes' : 'no'}`,
    `  cadence (cron):  ${config.cadence || '(not set)'}`,
    `  delivery channel: ${config.deliveryChannel || '(not set)'}`,
    `  quiet hours:     ${config.quietHours || '(none)'}`,
  ].join('\n');
}

export function renderReceipt(receipt: CheckinReceipt): string {
  const parts = [`  ${new Date(receipt.ranAt).toISOString()}  [${receipt.trigger}]  ${receipt.outcome}`];
  parts.push(`    ${receipt.briefingSummary}`);
  if (receipt.decisionReason) parts.push(`    reason: ${receipt.decisionReason}`);
  if (receipt.deliveredMessage) parts.push(`    delivered: ${receipt.deliveredMessage}`);
  if (receipt.deliveryChannel) parts.push(`    channel: ${receipt.deliveryChannel}`);
  if (receipt.error) parts.push(`    error: ${receipt.error}`);
  return parts.join('\n');
}

function rpcOf(ctx: CommandContext) {
  const rpc = getOperatorRpc(ctx);
  if (!rpc.available) throw commandRefusal(rpc.reason);
  return rpc;
}

export function registerCheckinRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'checkin',
    title: 'Check-ins',
    summary: 'The proactive check-in: its settings and what each one did, or one now',
    group: 'Automation',
    report: 'status',
    actions: [
      readAction<CommandContext>({
        id: 'status', label: 'See check-in settings and what they did', word: 'status',
        sentence: 'Shows whether check-ins are on, when they run and where they go, and the last ten check-ins: quiet, delivered or skipped.',
        operator: { method: 'checkin.receipts.list', fields: {} },
        async run(_values, ctx) {
          const rpc = rpcOf(ctx);
          try {
            const [{ config }, { receipts }] = await Promise.all([
              rpc.platformClient.operator.invoke('checkin.config.get', {}),
              rpc.platformClient.operator.invoke('checkin.receipts.list', { limit: 10 }),
            ]);
            return [renderConfig(config), '', ...(receipts.length === 0 ? ['No check-ins yet.'] : ['Recent check-ins:', ...receipts.map(renderReceipt)]), '', '  Change them in /settings (Automation); check in now: /checkin run'].join('\n');
          } catch (error) {
            throw commandRefusal(describeOperatorRpcError(error));
          }
        },
      }),
      {
        id: 'run', label: 'Check in now', word: 'run', inputs: [],
        sentence: 'One check-in runs now: it reads how things stand and, when something needs you, sends a message to the check-in channel.', done: '',
        touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out',
        operator: { method: 'checkin.run', fields: {} }, example: {},
        async run(_values, ctx) {
          const rpc = rpcOf(ctx);
          try {
            const result = await rpc.platformClient.operator.invoke('checkin.run', {});
            return [`Check-in: ${result.outcome}`, `  ${result.summary}`, ...(result.deliveryId ? [`  delivery ${result.deliveryId}`] : [])].join('\n');
          } catch (error) {
            throw commandRefusal(describeOperatorRpcError(error));
          }
        },
      },
    ],
  }));
}
