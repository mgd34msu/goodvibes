import { logger } from '../../utils/logger.js';
import { GitHubIntegration } from '../../integrations/github.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { TrySpawnAgentFn } from '../types.js';
import { parseJsonRecord, readRecord, readString, readTextBodyWithinLimit } from '../helpers.js';
import { inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';

/** Authors whose text may become an agent task; everyone else can open an issue or PR on a public repository. */
const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * The association of whoever wrote the text of an issue or pull request event,
 * or undefined for an event with no human author text (a CI check run).
 */
function authorAssociation(payload: Record<string, unknown>): string | undefined {
  const subject = readRecord(payload.pull_request) ?? readRecord(payload.issue);
  return readString(subject?.author_association)?.toUpperCase();
}

export async function handleGitHubAutomationWebhook(
  req: Request,
  context: {
    readonly serviceRegistry: ServiceRegistry;
    readonly githubWebhookSecret: string | null;
    readonly trySpawnAgent: TrySpawnAgentFn;
  },
): Promise<Response> {
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const githubWebhookSecret =
    context.githubWebhookSecret
    ?? await context.serviceRegistry.resolveSecret('github', 'signingSecret');
  if (!githubWebhookSecret) {
    logger.warn('handleGitHubAutomationWebhook: GITHUB_WEBHOOK_SECRET not configured, rejecting');
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const signature = req.headers.get('x-hub-signature-256') ?? '';
  if (!signature) {
    return Response.json({ error: 'Missing X-Hub-Signature-256 header' }, { status: 401 });
  }
  if (!GitHubIntegration.verifySignature(rawBody, signature, githubWebhookSecret)) {
    logger.warn('handleGitHubAutomationWebhook: GitHub webhook signature verification failed');
    return Response.json({ error: 'Invalid webhook signature' }, { status: 401 });
  }

  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;

  const event = GitHubIntegration.parseEvent(req.headers, body);
  // Only a comment can be the agent's own reply, so the lookup is skipped for other events.
  let ownLogin: string | null = null;
  if (event.type === 'issue_comment') {
    const token = (await context.serviceRegistry.resolveSecret('github', 'primary')) ?? process.env.GITHUB_TOKEN ?? null;
    if (token) ownLogin = await GitHubIntegration.resolveAuthenticatedLogin(token);
  }
  const prompt = GitHubIntegration.eventToPrompt(event, { ownLogin });
  if (prompt === null) {
    logger.info('handleGitHubAutomationWebhook: event ignored (no prompt generated)', {
      type: event.type,
      action: event.action,
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'event-not-actionable',
      message: 'Event not actionable',
    });
  }

  // A valid signature proves only that GitHub sent the event. The title and body
  // were written by whoever opened the issue or pull request, and become the
  // agent's task, so text from an author outside the repository's team is not run.
  const association = authorAssociation(body);
  if (association !== undefined && !TRUSTED_AUTHOR_ASSOCIATIONS.has(association)) {
    logger.info('handleGitHubAutomationWebhook: event ignored (author is not a repository member)', {
      type: event.type,
      action: event.action,
      association,
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'untrusted-author',
      message: `The author's association with the repository is ${association}; only OWNER, MEMBER and COLLABORATOR events start an agent.`,
    });
  }

  // GitHub redelivers on a timeout or on request, always with the same delivery id.
  const dedupKey = inboundDedupKey('github', readString(readRecord(body.repository)?.full_name), req.headers.get('x-github-delivery') ?? undefined);
  return runOncePerMessage(
    dedupKey,
    () => Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'duplicate-delivery',
      message: 'This delivery was already handled.',
    }),
    async () => {
      const spawnResult = await context.trySpawnAgent({ mode: 'spawn', task: prompt }, 'handleGitHubAutomationWebhook');
      if (spawnResult instanceof Response) return spawnResult;
      logger.info('handleGitHubAutomationWebhook: spawned agent', {
        type: event.type,
        action: event.action,
        agentId: spawnResult.id,
      });

      return Response.json({
        acknowledged: true,
        queued: true,
        agentId: spawnResult.id,
        eventType: event.type,
        action: event.action,
      });
    },
  );
}
