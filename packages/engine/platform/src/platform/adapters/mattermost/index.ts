import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, ingressMetadata, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
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
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const task = message;
    const policy = await context.authorizeSurfaceIngress({
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
      mentioned: declaredMention(body, Boolean(readString(body.trigger_word)) || readString(body.channel_type) === 'D' || readString(post?.channel_type) === 'D'),
      metadata: {
        ...body,
        ...(post ? { post } : {}),
      },
    });
    if (!policy.allowed) {
      return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
    }

    const binding = await context.routeBindings.upsertBinding({
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
    });
    if (!task) {
      const attachment = hasAttachments(post?.file_ids) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, binding, attachment, readString(body.channel_type) === 'D' || readString(post?.channel_type) === 'D') : false;
      return Response.json({
        ok: true,
        acknowledged: true,
        queued: false,
        outcome: 'ignored',
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        ...(attachment ? { attachment, notified } : {}),
        bindingId: binding.id,
      });
    }

    const controlCommand = await context.parseSurfaceControlCommand(task, { signal: req.signal });
    if (controlCommand) {
      const message = await context.performSurfaceControlCommand(controlCommand, { surface: 'mattermost', routeId: binding.id });
      return Response.json({ ok: true, acknowledged: true, message });
    }

    const submission = await context.sessionBroker.submitMessage({
      routeId: binding.id,
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      surfaceKind: 'mattermost',
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId ?? binding.channelId,
      userId,
      displayName: readString(body.user_name) ?? userId,
      title: binding.title ?? 'Mattermost',
      body: task,
      metadata: binding.metadata,
    });
    if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
      committed();
      return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
    }

    const spawnResult = await context.trySpawnAgent(
      { mode: 'spawn', task: submission.task! },
      'handleMattermostSurfaceWebhook',
      submission.session.id,
    );
    if (spawnResult instanceof Response) return spawnResult;
    committed();
    await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id, submission.input.id);
    context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
      agentId: spawnResult.id,
      task,
      sessionId: submission.session.id,
    });

    if ((req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
      return Response.json({
        response_type: 'ephemeral',
        text: 'GoodVibes accepted the request and is processing it.',
      });
    }
    return Response.json({
      ok: true,
      queued: true,
      bindingId: binding.id,
      sessionId: submission.session.id,
      agentId: spawnResult.id,
    });
  });
}
