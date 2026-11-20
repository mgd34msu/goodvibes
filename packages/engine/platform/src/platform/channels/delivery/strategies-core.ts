import { assertDeliveryCurrent, runDeliveryPublication } from '../../utils/delivery-lifetime.js';
import { retireDeliveryResponse } from '../../integrations/delivery-diagnostics.js';
import { ArtifactStore } from '../../artifacts/index.js';
import { ConfigManager } from '../../config/manager.js';
import { DEFAULT_CONFIG } from '../../config/schema.js';
import type { SecretsManager } from '../../config/secrets.js';
import { ServiceRegistry } from '../../config/service-registry.js';
import { resolveSecretInput } from '../../config/secret-refs.js';
import { ControlPlaneGateway } from '../../control-plane/gateway.js';
import { DiscordIntegration, HomeAssistantIntegration, NtfyIntegration, SlackIntegration, resolveNtfyDefaultPriority } from '../../integrations/index.js';
import { ownerDeliveryTargetProblem, postToPublicWebhook, validatePublicWebhookUrl } from '../../utils/url-safety.js';
import type { HostResolver } from '../../runtime/network/destination.js';
import { resolveReachableBaseUrl } from '../../utils/reachable-base-url.js';
import { resolveHomeAssistantAccessToken, resolveHomeAssistantEventType } from '../builtin/homeassistant.js';
import type { ChannelDeliveryRequest, ChannelDeliveryStrategy } from './types.js';
import {
  appendAttachmentSummary,
  assertPublicWebhookAddress,
  buildArtifactContentPath,
  buildArtifactContentUrl,
  deliveryFetch,
  extractResponseId,
  firstNonEmpty,
  fitForSurface,
  requireOkResponse,
  resolveDeliveryCredential,
  resolveAttachments,
  resolveChannelDeliverySurfaceKind,
  success,
  titleFromBody,
} from './shared.js';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/**
 * Posts to an explicit chat webhook address taken from a target or binding.
 * Such an address is untrusted input, so it is resolved, every answer checked,
 * pinned to a checked address, and never redirected (utils/url-safety.ts); a
 * name that merely looks public cannot carry the agent's output to an internal host.
 */
function postToExplicitChatWebhook(
  request: ChannelDeliveryRequest,
  label: string,
  address: string,
  headers: Record<string, string>,
  payload: unknown,
  resolveHost: HostResolver | undefined,
): Promise<Response> {
  assertPublicWebhookAddress(label, address);
  return postToPublicWebhook(address, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    ...(request.signal ? { signal: request.signal } : {}),
  }, { resolveHost, assertCurrent: request.assertCurrent, withPublication: request.withPublication });
}

async function requireChatWebhookOk(label: string, response: Response): Promise<void> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new HttpStatusError(`${label} webhook rejected the request (${response.status}): ${detail}`, { status: response.status });
  }
  await retireDeliveryResponse(response);
}

export function createWebhookDeliveryStrategy(
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  options: {
    /** Resolves the target host before delivery; the system resolver when absent (utils/url-safety.ts). */
    readonly resolveHost?: HostResolver | undefined;
    /**
     * The owner's approved hosts on their own network (`network.privateDeliveryHosts`),
     * applied to the targets the owner configured (the delivery target and
     * `surfaces.webhook.defaultTarget`), never to a binding's callback URL.
     */
    readonly privateDeliveryHosts?: (() => readonly string[]) | undefined;
  } = {},
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:webhook',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return request.target.kind === 'webhook' || resolveChannelDeliverySurfaceKind(request.target) === 'webhook';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      // A binding's callback and response URLs were supplied by the outside
      // party that bound it. The router and scheduled delivery copy them into
      // the target's address, so the origin is read from the binding, not from
      // whether the address was set: such an address is held to public hosts.
      const boundUrls = [request.binding?.metadata.callbackUrl, request.binding?.metadata.responseUrl]
        .filter((value): value is string => typeof value === 'string');
      const address = request.target.address
        ?? (typeof request.binding?.metadata.callbackUrl === 'string' ? request.binding.metadata.callbackUrl : undefined)
        // The default target is declared secret-bearing (it can carry its own
        // token), so it may be a secret reference.
        ?? await resolveSecretInput(configManager.get('surfaces.webhook.defaultTarget'), {
          diagnosticMode: 'structural',
          resolveLocalSecret: (key) => secretsManager.get(key),
          homeDirectory: secretsManager.getGlobalHome?.() ?? undefined,
        })
        ?? '';
      if (!address) throw new Error('Missing webhook delivery target');
      const outsideAddress = boundUrls.includes(address);
      const approvedPrivateHosts = outsideAddress ? undefined : options.privateDeliveryHosts?.() ?? [];
      if (approvedPrivateHosts === undefined) {
        const validation = validatePublicWebhookUrl(address);
        if (!validation.ok) throw new Error(validation.error);
      } else {
        const problem = ownerDeliveryTargetProblem(address, { approvedPrivateHosts });
        if (problem !== undefined) throw new Error(problem);
      }
      const timeoutMs = Number(configManager.get('surfaces.webhook.timeoutMs') ?? DEFAULT_CONFIG.surfaces.webhook.timeoutMs);
      // Resolved, every answer checked, pinned to a checked address (utils/url-safety.ts).
      const response = await postToPublicWebhook(address, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          text: request.body,
          message: request.body,
          title: request.title,
          jobId: request.jobId,
          runId: request.runId,
          routeId: request.binding?.id,
          attachments,
          artifacts: attachments,
        }),
      }, { resolveHost: options.resolveHost, approvedPrivateHosts, assertCurrent: request.assertCurrent, withPublication: request.withPublication });
      if (!response.ok) {
        throw new HttpStatusError(`HTTP ${response.status}: ${await response.text().catch(() => '')}`, { status: response.status });
      }
      await retireDeliveryResponse(response);
      return success();
    },
  };
}

export function createSlackDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  /** Resolves an explicit webhook host before delivery; the system resolver when absent. */
  options: { readonly resolveHost?: HostResolver | undefined } = {},
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:slack',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'slack';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
      const slack = new SlackIntegration('', '');
      const responseUrl = typeof request.binding?.metadata.responseUrl === 'string'
        ? request.binding.metadata.responseUrl
        : undefined;
      if (responseUrl?.startsWith('https://hooks.slack.com/')) {
        const response = await deliveryFetch(request, responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            blocks: slack.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments),
          }),
        }, 'opaque-url');
        try { await retireDeliveryResponse(response); }
        finally {
          if (!response.ok) throw new HttpStatusError('Slack response URL rejected the request', { status: response.status });
        }
        return success();
      }
      if (request.target.address?.startsWith('https://')) {
        await requireChatWebhookOk('Slack', await postToExplicitChatWebhook(
          request, 'Slack', request.target.address, { 'Content-Type': 'application/json' }, { text: bodyWithAttachments }, options.resolveHost,
        ));
        return success();
      }
      const channelId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.slack.defaultChannel') ?? ''),
      );
      if (channelId) {
        const botToken = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
          serviceName: 'slack', serviceField: 'primary', configKey: 'surfaces.slack.botToken',
          environmentValue: process.env.SLACK_BOT_TOKEN,
        });
        await new SlackIntegration('', botToken ?? '').postMessage(channelId, bodyWithAttachments, undefined, request);
        return success(channelId);
      }
      const webhookUrl = await serviceRegistry.resolveSecret('slack', 'webhookUrl') ?? process.env.SLACK_WEBHOOK_URL;
      await new SlackIntegration(webhookUrl ?? '', '').postWebhook(bodyWithAttachments, undefined, undefined, request);
      return success();
    },
  };
}

export function createDiscordDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  /** Resolves an explicit webhook host before delivery; the system resolver when absent. */
  options: { readonly resolveHost?: HostResolver | undefined } = {},
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:discord',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'discord';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
      const discord = new DiscordIntegration('', '');
      const applicationId = typeof request.binding?.metadata.applicationId === 'string'
        ? request.binding.metadata.applicationId
        : undefined;
      const interactionToken = typeof request.binding?.metadata.interactionToken === 'string'
        ? request.binding.metadata.interactionToken
        : undefined;
      const replyChannel = firstNonEmpty(request.binding?.channelId, request.binding?.externalId);
      if (applicationId && interactionToken) {
        // An interaction token lasts fifteen minutes. A reply that takes longer is
        // refused as an edit, so it is posted to the channel the command came from.
        const edited = await discord.editOriginalResponse(
          applicationId,
          interactionToken,
          '',
          [discord.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments)],
          request,
        ).then(() => true, (error: unknown) => {
          if (!replyChannel) throw error;
          logger.warn('Discord interaction edit refused; posting the reply to its channel', { channelId: replyChannel, error: summarizeError(error) });
          return false;
        });
        if (edited) return success();
      }
      if (request.target.address?.startsWith('https://')) {
        await requireChatWebhookOk('Discord', await postToExplicitChatWebhook(
          request, 'Discord', request.target.address, { 'Content-Type': 'application/json' }, { content: bodyWithAttachments }, options.resolveHost,
        ));
        return success();
      }
      const channelId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.discord.defaultChannelId') ?? ''),
      );
      if (channelId) {
        const botToken = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
          serviceName: 'discord', serviceField: 'primary', configKey: 'surfaces.discord.botToken',
          environmentValue: process.env.DISCORD_BOT_TOKEN,
        });
        await new DiscordIntegration('', botToken ?? '').postMessage(channelId, bodyWithAttachments, undefined, request);
        return success(channelId);
      }
      const webhookUrl = await serviceRegistry.resolveSecret('discord', 'webhookUrl') ?? process.env.DISCORD_WEBHOOK_URL;
      await new DiscordIntegration(webhookUrl ?? '', '').postWebhook(bodyWithAttachments, undefined, undefined, request);
      return success();
    },
  };
}

function priorityOption(configured: unknown): { priority?: 1 | 2 | 3 | 4 | 5 } {
  const priority = resolveNtfyDefaultPriority(configured);
  return priority === undefined ? {} : { priority };
}

export function createNtfyDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:ntfy',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'ntfy';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const baseUrl = String(configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
      const token = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
        serviceName: 'ntfy', serviceField: 'primary', configKey: 'surfaces.ntfy.token',
        environmentValue: process.env.NTFY_ACCESS_TOKEN,
      });
      const topic = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.ntfy.topic') ?? ''),
      );
      if (!topic) throw new Error('Missing ntfy topic');
      const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
      // undefined here means nothing configured resolves to a reachable
      // address, omit the click target rather than shipping a dead link.
      const baseUrlHint = resolveReachableBaseUrl(configManager, 'off-host');
      const primaryAttachment = attachments[0]!;
      const outcome = await ntfy.publish(topic, appendAttachmentSummary(request.body, attachments), {
        title: request.target.label ?? titleFromBody(request.body),
        ...(request.announces ? { announces: request.announces } : {}),
        ...priorityOption(configManager.get('surfaces.ntfy.defaultPriority')),
        ...(request.includeLinks && baseUrlHint ? { click: `${baseUrlHint}/api/control-plane/web` } : {}),
        ...(primaryAttachment?.contentUrl ? { attach: primaryAttachment.contentUrl } : {}),
        markGoodVibesOrigin: true,
        allowDuplicate: request.allowDuplicate === true,
        signal: request.signal,
        assertCurrent: request.assertCurrent,
        withPublication: request.withPublication,
      });
      return outcome === 'suppressed' ? { ...success(topic), suppressed: true } : success(topic);
    },
  };
}

export function createWebControlPlaneDeliveryStrategy(
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  getGateway: () => ControlPlaneGateway | null,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:web-control-plane',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'web';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const gateway = getGateway();
      if (!gateway) {
        throw new Error('Web control-plane gateway unavailable');
      }
      assertDeliveryCurrent(request);
      const published = await runDeliveryPublication(request, () => gateway.publishSurfaceMessage({
        surface: 'web',
        title: request.target.label ?? request.title,
        body: request.body,
        level: request.status === 'failed' ? 'error' : request.status === 'completed' ? 'success' : 'info',
        routeId: request.binding?.id ?? request.target.routeId,
        surfaceId: request.binding?.surfaceId,
        attachments,
        metadata: {
          jobId: request.jobId,
          runId: request.runId,
          agentId: request.agentId,
        },
      }));
      return success(published.id);
    },
  };
}

/** A file name for a link's label: lower case words joined by `-`. */
function linkFileStem(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'delivery';
}

/**
 * A link target: the result is published as an artifact, and the link to it
 * goes to the owner's web surface (the web UI and every client reading surface
 * messages). The target's address names the link. The receipt is the link
 * itself, so the delivery record says where the result is even when no web
 * client is connected; in a process that serves no web surface it names the
 * stored document instead. A notice that cannot be shown does not fail the
 * delivery, since the result is already published and a retry would publish
 * it twice.
 */
export function createLinkDeliveryStrategy(
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  getGateway: () => ControlPlaneGateway | null,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:link',
    supportsGuardedDelivery: true,
    supportsAttachments: true,
    canHandle(request) {
      return request.target.kind === 'link';
    },
    async deliver(request) {
      assertDeliveryCurrent(request);
      const label = firstNonEmpty(request.target.address?.trim(), request.target.label?.trim(), request.title) ?? 'GoodVibes delivery';
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      assertDeliveryCurrent(request);
      const artifact = await artifactStore.create({
        kind: 'document',
        mimeType: 'text/markdown',
        filename: `${linkFileStem(label)}-${request.runId}.md`,
        text: `# ${request.title}\n\n${appendAttachmentSummary(request.body, attachments).trimEnd()}\n`,
        metadata: {
          purpose: 'delivery-link',
          label,
          jobId: request.jobId,
          runId: request.runId,
          ...(request.agentId ? { agentId: request.agentId } : {}),
          ...(request.status ? { status: request.status } : {}),
        },
      }, { signal: request.signal, assertCurrent: () => assertDeliveryCurrent(request) });
      const gateway = getGateway();
      if (!gateway) {
        // Only the host serves artifact links; elsewhere the receipt names the stored document.
        logger.warn('Delivery document saved, but no web surface is attached to announce its link', { runId: request.runId, artifactId: artifact.id });
        return success(`artifact:${artifact.id}`);
      }
      const link = buildArtifactContentUrl(configManager, artifact.id) ?? buildArtifactContentPath(artifact.id);
      try {
        gateway.publishSurfaceMessage({
          surface: 'web',
          title: label,
          body: `${request.title}: ${link}`,
          level: request.status === 'failed' ? 'error' : request.status === 'completed' ? 'success' : 'info',
          attachments: [await artifactStore.toAttachment({ artifactId: artifact.id }, { contentUrl: link })],
          metadata: {
            jobId: request.jobId,
            runId: request.runId,
            agentId: request.agentId,
            artifactId: artifact.id,
          },
        });
      } catch (error) {
        logger.warn('Delivery link published, but its notice could not be shown on the web surface', { runId: request.runId, artifactId: artifact.id, error: summarizeError(error) });
      }
      return success(link);
    },
  };
}

export function createHomeAssistantDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:homeassistant',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'homeassistant';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const baseUrl = firstNonEmpty(
        String(configManager.get('surfaces.homeassistant.instanceUrl') ?? ''),
        serviceRegistry.get('homeassistant')?.baseUrl,
        process.env.HOMEASSISTANT_URL,
        process.env.HOME_ASSISTANT_URL,
        process.env.HA_URL,
      );
      if (!baseUrl) throw new Error('Missing Home Assistant instance URL');
      const token = await resolveHomeAssistantAccessToken({ configManager, secretsManager, serviceRegistry });
      if (!token) throw new Error('Missing Home Assistant access token');
      const eventType = resolveHomeAssistantEventType(configManager);
      const client = new HomeAssistantIntegration({ baseUrl, accessToken: token });
      const pending = readRecord(request.metadata?.pending);
      const messageId = firstNonEmpty(
        readString(pending?.messageId),
        readString(request.binding?.metadata.messageId),
      );
      const conversationId = firstNonEmpty(
        readString(pending?.conversationId),
        readString(request.binding?.metadata.conversationId),
        request.binding?.externalId,
      );
      const result = await client.publishGoodVibesEvent(eventType, {
        type: request.status === 'failed' ? 'error' : 'message',
        title: request.target.label ?? request.title,
        body: appendAttachmentSummary(request.body, attachments),
        speechText: request.body,
        status: request.status,
        jobId: request.jobId,
        runId: request.runId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        routeId: request.binding?.id,
        surfaceId: request.binding?.surfaceId,
        externalId: request.binding?.externalId,
        messageId: firstNonEmpty(readString(pending?.outboundMessageId), request.agentId ? `gv:${request.agentId}` : undefined),
        replyToMessageId: firstNonEmpty(readString(pending?.replyToMessageId), messageId),
        conversationId,
        metadata: {
          threadId: request.binding?.threadId,
          channelId: request.binding?.channelId,
          phase: readString(request.metadata?.phase),
          inboundMessageId: messageId,
          conversationId,
          attachments,
        },
      }, request);
      return success(extractResponseId(result) ?? eventType);
    },
  };
}

export function createTelegramDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:telegram',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'telegram';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const token = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
        serviceName: 'telegram', serviceField: 'primary', configKey: 'surfaces.telegram.botToken',
        environmentValue: process.env.TELEGRAM_BOT_TOKEN,
      });
      const chatId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.telegram.defaultChatId') ?? ''),
      );
      if (!token) throw new Error('Missing Telegram bot token');
      if (!chatId) throw new Error('Missing Telegram chat id');
      const fitted = fitForSurface(request.body, attachments, 4_096);
      const response = await deliveryFetch(request, `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: fitted.text,
          disable_web_page_preview: true,
          ...(request.binding?.threadId && /^\d+$/.test(request.binding.threadId)
            ? { message_thread_id: Number(request.binding.threadId) }
            : {}),
        }),
      }, 'opaque-url');
      const payload = await requireOkResponse('Telegram delivery failed', response);
      if (payload === null || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true) {
        throw new Error('Telegram did not acknowledge the send request');
      }
      const message = readRecord('result' in payload ? payload.result : undefined);
      const chat = readRecord(message?.['chat']);
      const sender = readRecord(message?.['from']), accountId = sender?.['id'];
      const messageId = message?.['message_id'], conversationId = chat?.['id'], threadId = message?.['message_thread_id'];
      // Do not reconstruct this from a configured @alias/default chat: it can
      // select a different recipient on the next boot. Incomplete provider
      // acknowledgements still prove a send, but cannot supply a recovery receipt.
      const receipt = typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0
        && typeof conversationId === 'number' && Number.isSafeInteger(conversationId) && conversationId !== 0
        && (threadId === undefined || typeof threadId === 'number' && Number.isSafeInteger(threadId) && threadId > 0)
        ? { surfaceKind: 'telegram' as const, conversationId: String(conversationId), messageId: String(messageId),
          ...(sender?.['is_bot'] === true && typeof accountId === 'number' && Number.isSafeInteger(accountId) && accountId > 0 ? { accountId: String(accountId) } : {}),
          ...(threadId === undefined ? {} : { threadId: String(threadId) }) } : undefined;
      return { ...success(extractResponseId(payload), fitted), ...(receipt === undefined ? {} : { receipt }) };
    },
  };
}

export function createGoogleChatDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  /** Resolves an explicit webhook host before delivery; the system resolver when absent. */
  options: { readonly resolveHost?: HostResolver | undefined } = {},
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:google-chat',
    supportsGuardedDelivery: true,
    supportsPublication: true,
    supportsAttachments: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'google-chat';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      // A conversation reply carries the space name (`spaces/AAAA`) as its
      // address; that is not a webhook, so the configured webhook is used. A
      // value that is written as a URL must be an https webhook of Google's.
      const addressText = firstNonEmpty(request.target.address);
      const addressIsUrl = addressText !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(addressText);
      const explicitTarget = addressIsUrl ? addressText : undefined;
      if (explicitTarget !== undefined) assertPublicWebhookAddress('Google Chat', explicitTarget);
      const boundWebhook = readString(request.binding?.metadata.webhookUrl);
      if (boundWebhook !== undefined) assertPublicWebhookAddress('Google Chat', boundWebhook);
      const untrustedWebhook = firstNonEmpty(explicitTarget, boundWebhook);
      const webhookUrl = untrustedWebhook
        ?? await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
          serviceName: 'google-chat', serviceField: 'webhookUrl', configKey: 'surfaces.googleChat.webhookUrl',
          serviceDefault: () => serviceRegistry.get('google-chat')?.baseUrl,
          environmentValue: process.env.GOOGLE_CHAT_WEBHOOK_URL,
        });
      if (!webhookUrl) {
        throw new Error('Missing Google Chat webhook URL');
      }
      const threadKey = firstNonEmpty(request.binding?.threadId, request.binding?.channelId, request.binding?.externalId);
      const fitted = fitForSurface(request.body, attachments, 4_000);
      const chatPayload = {
        text: fitted.text,
        ...(threadKey ? { thread: { threadKey } } : {}),
      };
      // A webhook from the target or binding is untrusted input; the configured one is the owner's.
      const response = untrustedWebhook !== undefined
        ? await postToExplicitChatWebhook(request, 'Google Chat', webhookUrl, { 'Content-Type': 'application/json; charset=UTF-8' }, chatPayload, options.resolveHost)
        : await deliveryFetch(request, webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify(chatPayload),
        }, 'opaque-url');
      const payload = await requireOkResponse('Google Chat delivery failed', response);
      return success(extractResponseId(payload), fitted);
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
