/**
 * channel-sends-composition.ts, the daemon's sends to a channel
 * (capabilities/builtin/channel-send.ts `channels.send`): through the daemon's
 * own channel router, the one its scheduled runs and channel turns deliver
 * through, each send's receipt kept in the daemon's sends store beside its
 * deliveries (`~/.goodvibes/daemon/channels/delivery-receipts.json`).
 *
 * The Agent's own receipts (3.5.0, `~/.goodvibes/agent/channels/
 * delivery-receipts.json`) are carried into that store once, when it does not
 * exist yet; the Agent's file is left as it was, so a 3.5.0 Agent after a
 * rollback still lists them.
 */
import type { ChannelDeliveryRouter } from '@goodvibes/engine/platform/platform/channels';
import type { ChannelSendCapabilityServices } from '@goodvibes/engine/platform/platform/capabilities';
import { Secret } from '@goodvibes/engine/platform/platform/security';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { deliverAgentChannelMessage, describeNamedDeliveryTarget } from '@goodvibes/engine/terminal-shell/agent-turn/channel-delivery';
import {
  carryAgentChannelDeliveryReceipts, daemonChannelDeliveryReceiptPath, readAgentChannelDeliveryReceipts, recordAgentChannelDeliveryReceipt,
} from '@goodvibes/engine/terminal-shell/agent-turn/channel-delivery-receipts';

export interface ChannelSendsSources {
  readonly router: Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>;
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
}

/** The daemon's sends to a channel and the receipts it keeps; the Agent's receipts are carried in once, here. */
export function createDaemonChannelSends(sources: ChannelSendsSources): ChannelSendCapabilityServices['channelSends'] {
  try {
    const carried = carryAgentChannelDeliveryReceipts(sources.shellPaths);
    if (carried > 0) logger.info('The Agent\'s channel send receipts are now the daemon\'s', { carried });
  } catch (error) {
    logger.warn('The Agent\'s channel send receipts could not be carried into the daemon\'s; they stay in its file', { error: summarizeError(error) });
  }
  const path = daemonChannelDeliveryReceiptPath(sources.shellPaths);
  return {
    async send(input) {
      const delivery = { ...input, ...(input.webhook ? { webhook: Secret.of(input.webhook, 'channels.send webhook') } : {}) };
      const result = await deliverAgentChannelMessage(sources.router, delivery);
      let receiptId: string | undefined;
      let receiptNote: string | undefined;
      try {
        const receipt = recordAgentChannelDeliveryReceipt(sources.shellPaths, { source: 'command', deliveryInput: delivery, result }, path);
        receiptId = receipt.id;
        if (receipt.storeNote) receiptNote = receipt.storeNote;
      } catch (error) {
        receiptNote = `It was sent; its receipt could not be kept (${summarizeError(error)}).`;
      }
      return { target: describeNamedDeliveryTarget(delivery), ...(result.responseId ? { responseId: result.responseId } : {}), ...(receiptId ? { receiptId } : {}), ...(receiptNote ? { receiptNote } : {}) };
    },
    receipts() {
      const snapshot = readAgentChannelDeliveryReceipts(sources.shellPaths, path);
      return {
        receipts: snapshot.receipts.map((receipt) => ({
          id: receipt.id, createdAt: receipt.createdAt, source: receipt.source, target: receipt.target.display, title: receipt.title,
          messagePreview: receipt.messagePreview, ...(receipt.responseId ? { responseId: receipt.responseId } : {}),
        })),
        ...(snapshot.parseError ? { unreadable: snapshot.parseError } : {}),
      };
    },
  };
}
