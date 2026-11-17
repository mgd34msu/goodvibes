import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/platform/platform/channels';
import { lstatSync, realpathSync } from 'node:fs';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';
import type { Tool, ToolExecuteOptions } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolEffect, assertCurrentToolExecution, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate/judgment-input';
import { evaluateOutwardEffect, getProcessUntrustedContentLedger as getSessionUntrustedContentLedger } from '@goodvibes-jev/engine/platform/platform/security';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryPreview,
  formatAgentChannelDeliveryResult,
} from './channel-delivery.js';
import { agentChannelDeliveryReceiptPath, recordAgentChannelDeliveryReceipt } from './channel-delivery-receipts.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import { toolErrorText } from './tool-error-text.js';
import { readFlag } from './tool-args.js';

export interface AgentChannelSendToolArgs {
  readonly message?: unknown | undefined;
  readonly title?: unknown | undefined;
  readonly channel?: unknown | undefined;
  readonly route?: unknown | undefined;
  readonly webhook?: unknown | undefined;
  readonly link?: unknown | undefined;
  readonly confirm?: unknown | undefined;
  readonly preview?: unknown | undefined;
  readonly explicitUserRequest?: unknown | undefined;
}

export interface AgentChannelSendToolOptions {
  readonly shellPaths?: (Pick<ShellPathService, 'resolveUserPath'> & Partial<Pick<ShellPathService, 'homeDirectory'>>) | undefined;
}

/**
 * Whether this call still holds the send its admission recorded: the call's
 * own engine execution and its recorded `send` effect, checked again before
 * every step. The tool is registered without an input projection and nothing
 * forwards a translated call to it, so this is the whole of what the Agent's
 * harness ingress answered for it; it is stated here so the same check runs
 * in the Agent process and in a turn the daemon hosts.
 */
function sendStillAdmitted(args: Record<string, unknown>, options: ToolExecuteOptions | undefined): boolean {
  options?.signal?.throwIfAborted();
  assertCurrentToolExecution(args, options);
  return assertCurrentToolEffect(args, options, 'send');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
      description: 'Preview or deliver one message through one configured Agent target. Exactly one of channel, route, webhook or link is required. Delivery requires current recorded effect admission.',
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
            description: 'Channel target: "<channel>", "<channel>:<route id>" or "<channel>:<route id> | <label>" (the route id is taken whole, colons included). Give exactly one of channel, route, webhook or link.',
          },
          route: {
            type: 'string',
            description: 'Route id, or "<route id> | <label>" (the route id is taken whole, colons included). Give exactly one of channel, route, webhook or link.',
          },
          webhook: {
            type: 'string',
            description: 'http(s) webhook URL. Give exactly one of channel, route, webhook or link.',
          },
          link: {
            type: 'string',
            description: 'Name for a link: the message is published as a document and its link shown on the owner\'s web surface. Give exactly one of channel, route, webhook or link.',
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
      let preview: ReturnType<typeof buildAgentChannelDeliveryPreview>;
      try {
        preview = buildAgentChannelDeliveryPreview(input);
      } catch (error) {
        return failure(toolErrorText(error));
      }
      if (readFlag(args.preview, 'preview', false)) {
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
        if (!sendStillAdmitted(rawArgs, executionOptions)) throw new ToolInputProjectionError('held');
        const current = listStrategies.call(channelDeliveryRouter);
        if (channelDeliveryRouter.deliver !== deliver || channelDeliveryRouter.listStrategies !== listStrategies
          || getSessionUntrustedContentLedger() !== ledger || ledgerSnapshot() !== sources
          || current.length !== strategies.length || strategies.some((source, index) => current[index] !== source.strategy
            || source.strategy.canHandle !== source.canHandle || source.strategy.deliver !== source.deliver)) throw new ToolInputProjectionError('held');
      };
      try { assertCurrent(); } catch (error) { return failure(toolErrorText(error)); }
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
        const result = await deliverAgentChannelMessage(trackedRouter, input, { ...(executionOptions?.signal ? { signal: executionOptions.signal } : {}), assertCurrent });
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
            if (receipt.storeNote) lines.push(`  ${receipt.storeNote}`);
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
            `  target ${input.channel ?? input.route ?? input.webhook ?? input.link}`,
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
