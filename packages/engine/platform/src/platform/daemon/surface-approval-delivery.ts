/**
 * surface-approval-delivery.ts, per-surface rendering of an approval update.
 *
 * Split out of surface-delivery.ts, which was over the 800-line cap. These
 * four are a cohesive block: each takes the same approval + route binding and
 * differs only in how that surface expresses "approve / deny / here is the
 * console link". Nothing here decides WHICH surface to use, that stays in
 * DaemonSurfaceDeliveryHelper.notifyApprovalUpdate, the one router. Each one
 * says whether the update got there, so the router can try the owner's other
 * conversations when an approval prompt did not.
 *
 * Every function takes its collaborators as an object rather than a bound
 * method. Passing `configManager.get` on its own would lose the receiver and
 * throw inside the ConfigManager (`this.resolvePath` is undefined), the same
 * defect class this round fixed in the control-plane gateway registration.
 */
import type { ConfigManager } from '../config/manager.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SharedApprovalRecord } from '../control-plane/index.js';
import { SlackIntegration, DiscordIntegration, NtfyIntegration, resolveNtfyDefaultPriority } from '../integrations/index.js';
import { logger } from '../utils/logger.js';
import { postToPublicWebhook, validatePublicWebhookUrl } from '../utils/url-safety.js';
import type { HostResolver } from '../tools/fetch/pinned-request.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveSurfaceSecret } from '../channels/builtin/surface-secrets.js';
import type { SurfaceNoticeDelivery } from './types.js';

type RouteBinding = import('../automation/routes.js').AutomationRouteBinding;

export interface SurfaceApprovalDeliveryDeps {
  readonly serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly controlPlaneWebUrl: (
    input: { readonly approvalId?: string; readonly sessionId?: string | undefined },
  ) => string | undefined;
  readonly resolveSlackWebhookUrl: () => Promise<string | null>;
  readonly resolveSlackBotToken: () => Promise<string | null>;
  /** The ntfy access token; the setup schema's reader (registry, `surfaces.ntfy.token`, environment) when absent. */
  readonly resolveNtfyToken?: (() => Promise<string | null>) | undefined;
  /** The Discord bot token; the setup schema's reader (registry, `surfaces.discord.botToken`, environment) when absent. */
  readonly resolveDiscordBotToken?: (() => Promise<string | null>) | undefined;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  /** Resolves a delivery host before posting; the system resolver when absent (utils/url-safety.ts). */
  readonly resolveHost?: HostResolver | undefined;
}

function failed(error: unknown): SurfaceNoticeDelivery {
  return { delivered: false, reason: 'delivery-failed', error: summarizeError(error) };
}

/** 'pending' and 'claimed' both still want the approve/deny affordance. */
function isPendingApproval(approval: SharedApprovalRecord): boolean {
  return approval.status === 'pending' || approval.status === 'claimed';
}

export async function deliverSlackApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<SurfaceNoticeDelivery> {
  const webUrl = deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
  const isPending = isPendingApproval(approval);
  const summary = approval.request.analysis.summary;
  const webhookUrl = await deps.resolveSlackWebhookUrl();
  const botToken = await deps.resolveSlackBotToken();
  const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
  const blocks = isPending
    ? [
        { type: 'section', text: { type: 'mrkdwn', text: `*Approval required* for \`${approval.request.tool}\`\n${summary}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: `gv:approval:approve:${approval.id}` },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny' }, action_id: `gv:approval:deny:${approval.id}` },
            ...(webUrl ? [{ type: 'button', text: { type: 'plain_text', text: 'Review in the app' }, url: webUrl }] : []),
          ],
        },
      ]
    : undefined;
  const text = isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`;
  if (typeof binding.metadata.responseUrl === 'string' && binding.metadata.responseUrl.startsWith('https://')) {
    // Held to the webhook rules: resolved, every answer checked, pinned, no redirects.
    const delivered = await postToPublicWebhook(binding.metadata.responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'in_channel',
        text,
        ...(blocks ? { blocks } : {}),
      }),
    }, { resolveHost: deps.resolveHost }).then(() => true, (error: unknown) => {
      logger.warn('Slack approval response delivery failed', {
        approvalId: approval.id,
        fallback: binding.channelId ? 'the bound channel' : 'none',
        error: summarizeError(error),
      });
      return error;
    });
    if (delivered === true) return { delivered: true };
    if (!binding.channelId) return failed(delivered);
  }
  if (!binding.channelId) return { delivered: false, reason: 'no-deliverable-target' };
  try {
    await slack.postMessage(binding.channelId, text, blocks);
    return { delivered: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deliverDiscordApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<SurfaceNoticeDelivery> {
  const webUrl = deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
  const isPending = isPendingApproval(approval);
  const summary = approval.request.analysis.summary;
  const webhookUrl = await resolveSurfaceSecret(deps, 'discord', 'webhookUrl');
  const botToken = deps.resolveDiscordBotToken
    ? await deps.resolveDiscordBotToken() ?? undefined
    : await resolveSurfaceSecret(deps, 'discord', 'primary') ?? undefined;
  const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
  const content = isPending
    ? `Approval required for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`
    : `Approval ${approval.status} for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`;
  const applicationId = typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined;
  const interactionToken = typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined;
  if (applicationId && interactionToken) {
    // An interaction token lasts fifteen minutes; when the edit is refused, the channel it came from still takes a post.
    const edited = await discord.editOriginalResponse(applicationId, interactionToken, content).then(() => true, (error: unknown) => {
      logger.warn('Discord approval interaction update failed', {
        approvalId: approval.id,
        fallback: binding.channelId ? 'the channel' : 'none',
        error: summarizeError(error),
      });
      return error;
    });
    if (edited === true) return { delivered: true };
    if (!binding.channelId) return failed(edited);
  }
  if (!binding.channelId) return { delivered: false, reason: 'no-deliverable-target' };
  try {
    await discord.postMessage(binding.channelId, content);
    return { delivered: true };
  } catch (error) {
    logger.warn('Discord approval channel update failed', {
      approvalId: approval.id,
      channelId: binding.channelId,
      error: summarizeError(error),
    });
    return failed(error);
  }
}

export async function deliverNtfyApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<SurfaceNoticeDelivery> {
  const topic = binding.channelId ?? binding.externalId;
  if (!topic) return { delivered: false, reason: 'no-deliverable-target' };
  const webUrl = deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
  const isPending = isPendingApproval(approval);
  const summary = approval.request.analysis.summary;
  const ntfy = new NtfyIntegration(
    String(deps.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
    deps.resolveNtfyToken
      ? await deps.resolveNtfyToken() ?? undefined
      : await resolveSurfaceSecret(deps, 'ntfy', 'primary') ?? undefined,
  );
  const priority = resolveNtfyDefaultPriority(deps.configManager.get('surfaces.ntfy.defaultPriority'));
  try {
    await ntfy.publish(topic, `${isPending ? 'Approval required' : `Approval ${approval.status}`}: ${summary}`, {
      title: approval.request.tool,
      ...(priority === undefined ? {} : { priority }),
      ...(webUrl ? { click: webUrl } : {}),
      markGoodVibesOrigin: true,
    });
    return { delivered: true };
  } catch (error) {
    logger.warn('ntfy approval update failed', { approvalId: approval.id, topic, error: summarizeError(error) });
    return failed(error);
  }
}

export async function deliverWebhookApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<SurfaceNoticeDelivery> {
  if (typeof binding.metadata.callbackUrl !== 'string') return { delivered: false, reason: 'no-deliverable-target' };
  const validation = validatePublicWebhookUrl(binding.metadata.callbackUrl);
  if (!validation.ok) {
    logger.warn('DaemonServer: refusing unsafe webhook approval callback URL', {
      approvalId: approval.id,
      reason: validation.error,
    });
    return { delivered: false, reason: 'no-deliverable-target', error: validation.error };
  }
  const payload = JSON.stringify({
    type: 'approval',
    approval,
    webUrl: deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId }) ?? null,
  });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const secret = String(deps.configManager.get('surfaces.webhook.secret') ?? '');
  if (secret) {
    headers.set('X-Goodvibes-Signature', deps.signWebhookPayload(payload, secret));
  }
  // Resolved, every answer checked, pinned to a checked address (utils/url-safety.ts).
  try {
    await postToPublicWebhook(validation.url, {
      method: 'POST',
      headers,
      body: payload,
    }, { resolveHost: deps.resolveHost });
    return { delivered: true };
  } catch (error) {
    logger.warn('Webhook approval update failed', { approvalId: approval.id, error: summarizeError(error) });
    return failed(error);
  }
}
