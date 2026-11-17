import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/platform/platform/channels';
import { lstatSync, realpathSync } from 'node:fs';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryPreview,
  formatAgentChannelDeliveryResult,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { agentChannelDeliveryReceiptPath, recordAgentChannelDeliveryReceipt } from '../agent/channel-delivery-receipts.ts';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import { confirmParameter, requestParameter } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

export interface AgentChannelSendToolArgs {
  readonly message?: unknown;
  readonly title?: unknown;
  readonly channel?: unknown;
  readonly route?: unknown;
  readonly webhook?: unknown;
  readonly link?: unknown;
  readonly confirm?: unknown;
  readonly preview?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface AgentChannelSendToolOptions {
  readonly shellPaths?: Pick<ShellPathService, 'resolveUserPath'> & Partial<Pick<ShellPathService, 'homeDirectory'>>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

export function createAgentChannelSendTool(
  channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>,
  options: AgentChannelSendToolOptions = {},
): Tool {
  return {
    definition: {
      name: 'agent_channel_send',
      activity: { doing: 'Sending', did: 'sent', object: 'a message', objects: 'messages' },
      description: 'Preview or deliver one message through one configured Agent target. Exactly one of channel, route or webhook is required. Delivery requires current recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Plain-text message to deliver.',
          },
          title: {
            type: 'string',
            description: 'Optional delivery title.',
          },
          channel: {
            type: 'string',
            description: 'Channel target. Give exactly one of channel, route or webhook.',
          },
          route: {
            type: 'string',
            description: 'Route id or route:label. Give exactly one of channel, route or webhook.',
          },
          webhook: {
            type: 'string',
            description: 'http(s) webhook URL. Give exactly one of channel, route or webhook.',
          },
          confirm: confirmParameter(),
          preview: {
            type: 'boolean',
            description: 'Return a read-only delivery preview without sending.',
          },
          explicitUserRequest: requestParameter(),
        },
        required: ['message'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions) => {
      const args = snapshotJudgmentInput(rawArgs) as AgentChannelSendToolArgs;
      const input = {
        message: readString(args.message) ?? '',
        ...(readString(args.title) ? { title: readString(args.title) } : {}),
        ...(readString(args.channel) ? { channel: readString(args.channel) } : {}),
        ...(readString(args.route) ? { route: readString(args.route) } : {}),
        ...(readString(args.webhook) ? { webhook: readString(args.webhook) } : {}),
        ...(readString(args.link) ? { link: readString(args.link) } : {}),
      };
      // No delivery strategy handles a link target, so accepting one would pass
      // the preview and the safety gate and then fail at delivery.
      if (input.link) {
        return failure('agent_channel_send cannot deliver to a link: no delivery strategy handles one. Use exactly one of channel, route or webhook.');
      }
      let preview: ReturnType<typeof buildAgentChannelDeliveryPreview>;
      try {
        preview = buildAgentChannelDeliveryPreview(input);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      if (readBoolean(args.preview)) {
        return output(formatAgentChannelDeliveryPreview(preview, channelDeliveryRouter.listStrategies().length));
      }
      const ledger = getSessionUntrustedContentLedger();
      const ledgerSnapshot = () => JSON.stringify([ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
      const sources = ledgerSnapshot();
      const receiptPaths = options.shellPaths, receiptResolver = receiptPaths?.resolveUserPath, receiptHome = receiptPaths?.homeDirectory;
      const receiptPath = receiptPaths && agentChannelDeliveryReceiptPath(receiptPaths);
      let receiptRoot: string | undefined;
      try {
        receiptRoot = receiptHome ? realpathSync(receiptHome) : undefined;
      } catch (error) {
        return failure(`The Agent home directory is not available, so nothing was sent: ${error instanceof Error ? error.message : String(error)}`);
      }
      const deliver = channelDeliveryRouter.deliver, listStrategies = channelDeliveryRouter.listStrategies;
      const strategies = listStrategies.call(channelDeliveryRouter).map(strategy => ({ strategy, canHandle: strategy.canHandle, deliver: strategy.deliver }));
      const assertCurrent = () => {
        executionOptions?.signal?.throwIfAborted();
        if (!harnessCatalogInvocationAuthority(rawArgs, executionOptions, 'send')) throw new ToolInputProjectionError('held');
        const current = listStrategies.call(channelDeliveryRouter);
        if (channelDeliveryRouter.deliver !== deliver || channelDeliveryRouter.listStrategies !== listStrategies
          || getSessionUntrustedContentLedger() !== ledger || ledgerSnapshot() !== sources
          || current.length !== strategies.length || strategies.some((source, index) => current[index] !== source.strategy
            || source.strategy.canHandle !== source.canHandle || source.strategy.deliver !== source.deliver)) throw new ToolInputProjectionError('held');
      };
      try { assertCurrent(); } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
      // Delivering a channel message is an outward effect and had no
      // untrusted-content gate at all, the ledger was never consulted here, so
      // a page or a mailbox the agent had just read could dictate the text of a
      // message to a webhook, a channel or a link. `confirm:true` and
      // `explicitUserRequest` do not close that: both are set by the model, and
      // a model that has just read an injected instruction is exactly what they
      // fail against.
      //
      // Every field is enumerated, so this asks the narrow question rather than
      // the blunt one, a message the owner composed goes even when the turn has
      // read something, and only one that repeats what was read is refused.
      const outwardDecision = await evaluateOutwardEffect({
        request: {
          toolName: 'agent_channel_send',
          action: 'channel.send',
          // The target as the caller named it, not the resolved target object:
          // a refusal has to say the thing the reader typed.
          description: `sending a channel message to ${input.channel ?? input.route ?? input.webhook ?? input.link ?? 'the named target'}`,
        },
        ledger,
        content: {
          message: input.message,
          title: input.title,
          channel: input.channel,
          route: input.route,
          webhook: input.webhook,
          link: input.link,
        },
        taintOptions: {
          signal: executionOptions?.signal,
          // Where the message GOES. A webhook URL lifted out of a page is the
          // redirect attack in its purest form, and it is short enough to pass
          // both length thresholds, so these are tested by containment.
          exactMatchFields: ['channel', 'route', 'webhook', 'link'],
        },
      });
      assertCurrent();
      if (!outwardDecision.allowed) {
        return failure([outwardDecision.reason ?? 'Outward channel delivery held.', outwardDecision.fix].filter(Boolean).join(' '));
      }
      // Whether the provider already accepted the message. A check that fails
      // after that point does not make the send a failure, and saying "held"
      // would invite a retry that sends it twice.
      let accepted: { readonly responseId: string | undefined } | undefined;
      const trackedRouter = {
        deliver: async (request: Parameters<typeof deliver>[0]) => {
          const responseId = await deliver.call(channelDeliveryRouter, request);
          accepted = { responseId };
          return responseId;
        },
        listStrategies: () => listStrategies.call(channelDeliveryRouter),
      };
      try {
        const result = await deliverAgentChannelMessage(trackedRouter, input, { signal: executionOptions?.signal, assertCurrent });
        const lines = [formatAgentChannelDeliveryResult(result)];
        if (options.shellPaths) {
          try {
            assertCurrent();
            if (!receiptPaths || !receiptHome || !receiptRoot || !receiptPath || options.shellPaths !== receiptPaths
              || receiptPaths.resolveUserPath !== receiptResolver || receiptPaths.homeDirectory !== receiptHome
              || realpathSync(receiptHome) !== receiptRoot || agentChannelDeliveryReceiptPath(receiptPaths) !== receiptPath) throw new ToolInputProjectionError('held');
            resolveAndValidatePath(receiptPath, receiptHome);
            if (lstatSync(receiptPath, { throwIfNoEntry: false })?.isSymbolicLink()) realpathSync(receiptPath);
            const receipt = recordAgentChannelDeliveryReceipt(receiptPaths, {
              source: 'model-tool',
              deliveryInput: input,
              result,
            });
            lines.push(`  receipt ${receipt.id}`);
          } catch (receiptError) {
            lines.push(`  receipt unavailable ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
          }
        }
        return output(lines.join('\n'));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (accepted) {
          return output([
            'Agent channel delivery sent',
            `  target ${input.channel ?? input.route ?? input.webhook}`,
            ...(accepted.responseId ? [`  response ${accepted.responseId}`] : []),
            `  note the message was accepted for delivery, then a follow-up check failed (${reason}); no delivery receipt was recorded and the send was not retried. Do not send it again.`,
          ].join('\n'));
        }
        return failure(reason);
      }
    },
  };
}

export function registerAgentChannelSendTool(
  registry: ToolRegistry,
  channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>,
  options: AgentChannelSendToolOptions = {},
): void {
  registry.register(createAgentChannelSendTool(channelDeliveryRouter, options));
}
