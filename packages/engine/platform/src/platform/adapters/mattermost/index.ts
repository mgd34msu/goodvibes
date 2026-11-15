import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, ingressMetadata, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import type { SurfaceAdapterContext } from '../types.js';

async function readBody(req: Request): Promise<Record<string, unknown> | Response | null> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const contentLengthHeader = req.headers.get('content-length');
    const contentLength = parseInt(contentLengthHeader ?? '', 10);
    if (!contentLengthHeader || !Number.isFinite(contentLength)) {
      return Response.json({ error: 'Content-Length required for multipart payloads' }, { status: 411 });
    }
    if (contentLength > 1_000_000) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: 'Invalid multipart webhook payload' }, { status: 400 });
    }
    return Object.fromEntries(
      [...form.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]),
    );
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  const parsed = parseJsonRecord(rawBody);
  return parsed instanceof Response ? null : readRecord(parsed);
}

export async function handleMattermostSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const credential = await resolveSurfaceCredential(
    context,
    // A secret of its own for inbound calls comes first, so the account's
    // delivery credential is not the shared secret a caller must hold. The
    // delivery credential stays as the fallback for a surface that has not set one.
    { kind: 'config', key: 'surfaces.mattermost.webhookSecret' },
    { kind: 'registry', service: 'mattermost', field: 'signingSecret' },
    { kind: 'env', name: 'MATTERMOST_WEBHOOK_SECRET' },
    { kind: 'config', key: 'surfaces.mattermost.botToken' },
    { kind: 'registry', service: 'mattermost', field: 'primary' },
    { kind: 'env', name: 'MATTERMOST_BOT_TOKEN' },
  );
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('mattermost', credential);
  if (credential.state === 'absent') return Response.json({ error: 'Webhook credential is not configured' }, { status: 503 });
  const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
  // Mattermost's outgoing webhooks send their token in the body; a header or
  // bearer token is preferred when present. A token in a header is checked
  // before the body is read, so an unauthenticated caller costs no parsing
  // (`readBearerOrHeaderToken` returns '' when neither header is set).
  const headerToken = readBearerOrHeaderToken(req, 'x-goodvibes-mattermost-token');
  if (credential.state === 'resolved' && headerToken && !constantTimeEquals(credential.value, headerToken)) return unauthorized();
  const body = await readBody(req);
  if (body instanceof Response) return body;
  if (!body) return Response.json({ error: 'Invalid webhook payload' }, { status: 400 });
  const providedToken = headerToken || readString(body.token) || '';
  if (credential.state === 'resolved' && !constantTimeEquals(credential.value, providedToken)) return unauthorized();

  const post = typeof body.post === 'string'
    ? (() => {
        try {
          return readRecord(JSON.parse(body.post));
        } catch {
          return null;
        }
      })()
    : readRecord(body.post);
  const message = readString(post?.message) ?? readString(body.text) ?? '';
  const channelId = readString(post?.channel_id) ?? readString(body.channel_id);
  const threadId = readString(post?.root_id) ?? readString(body.root_id);
  const userId = readString(post?.user_id) ?? readString(body.user_id);
  const teamId = readString(post?.team_id) ?? readString(body.team_id);
  if (!channelId) return Response.json({ error: 'Missing channel id' }, { status: 400 });

  const dedupKey = inboundDedupKey('mattermost', channelId, readString(post?.id) ?? readString(body.post_id));
  const direct = readString(body.channel_type) === 'D' || readString(post?.channel_type) === 'D';
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const task = message;
    const outcome = await runSurfaceMessage(context, {
      ingress: {
        surface: 'mattermost',
        userId,
        channelId,
        groupId: teamId ?? channelId,
        threadId,
        workspaceId: teamId,
        conversationKind: threadId ? 'thread' : 'channel',
        text: task,
        // An outgoing webhook only fires on its trigger word, which is the mention;
        // a direct message is addressed to the bot by definition.
        mentioned: declaredMention(body, Boolean(readString(body.trigger_word)) || direct),
        metadata: {
          ...body,
          ...(post ? { post } : {}),
        },
      },
      binding: {
        kind: threadId ? 'thread' : 'channel',
        surfaceKind: 'mattermost',
        surfaceId: teamId ?? 'mattermost',
        externalId: threadId ?? channelId,
        channelId,
        threadId,
        title: readString(body.channel_name) ?? channelId,
        metadata: {
          ...ingressMetadata(body),
          ...(post ? { post } : {}),
        },
      },
      text: task,
      logLabel: 'handleMattermostSurfaceWebhook',
      // An outgoing webhook shows the `text` of its answer in the channel.
      control: 'response',
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      userId,
      displayName: readString(body.user_name) ?? userId,
      signal: req.signal,
      committed,
    });
    if (outcome.kind === 'no-text') {
      const attachment = hasAttachments(post?.file_ids) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, direct) : false;
      return Response.json({
        ok: true,
        acknowledged: true,
        queued: false,
        outcome: 'ignored',
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        ...(attachment ? { attachment, notified } : {}),
        bindingId: outcome.binding.id,
      });
    }
    if (outcome.kind === 'control') return surfaceOutcomeResponse(outcome, { text: outcome.message });
    if (outcome.kind === 'started' && (req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
      return Response.json({
        response_type: 'ephemeral',
        text: 'GoodVibes accepted the request and is processing it.',
      });
    }
    return surfaceOutcomeResponse(outcome);
  });
}
