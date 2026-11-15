import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { GitHubIntegration, type GitHubReplyTarget } from '../../integrations/github.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { AgentRecord } from '../../tools/agent/index.js';
import type { TrySpawnAgentFn } from '../types.js';
import { parseJsonRecord, readRecord, readString, readTextBodyWithinLimit } from '../helpers.js';
import { inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';

export async function handleGitHubAutomationWebhook(
  req: Request,
  context: {
    readonly serviceRegistry: ServiceRegistry;
    readonly githubWebhookSecret: string | null;
    readonly trySpawnAgent: TrySpawnAgentFn;
    /**
     * Resolves when an agent has finished, with its final record. When wired,
     * the integration posts the agent's answer to the issue or pull request;
     * without it the agent is asked to post the answer itself.
     */
    readonly awaitAgent?: ((agentId: string) => Promise<AgentRecord | null>) | undefined;
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
  const resolveToken = async (): Promise<string | null> => (await context.serviceRegistry.resolveSecret('github', 'primary')) ?? process.env.GITHUB_TOKEN ?? null;
  // Whether a comment mentions the bot is read before GitHub is asked for the token's login.
  const decision = await GitHubIntegration.readEvent(event, { resolveToken, postsReply: context.awaitAgent !== undefined });
  if (decision.kind === 'ignored') {
    logger.info('handleGitHubAutomationWebhook: event ignored', {
      type: event.type,
      action: event.action,
      reason: decision.reason,
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: decision.reason,
      message: decision.message,
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
      const spawnResult = await context.trySpawnAgent({ mode: 'spawn', task: decision.prompt }, 'handleGitHubAutomationWebhook');
      if (spawnResult instanceof Response) return spawnResult;
      if (decision.reply && context.awaitAgent) void postAgentAnswer(context.awaitAgent, spawnResult.id, decision.reply, resolveToken);
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
        replyPosted: decision.reply ? 'on-completion' : 'by-agent',
      });
    },
  );
}

/**
 * Posts a finished agent's answer to the issue or pull request its event came
 * from. Runs after GitHub was answered; a failure is logged, never thrown.
 */
async function postAgentAnswer(
  awaitAgent: (agentId: string) => Promise<AgentRecord | null>,
  agentId: string,
  target: GitHubReplyTarget,
  resolveToken: () => Promise<string | null>,
): Promise<void> {
  const where = `${target.owner}/${target.repo}#${target.number}`;
  try {
    const record = await awaitAgent(agentId);
    const answer = record?.fullOutput?.trim();
    if (record?.status !== 'completed' || !answer) {
      logger.warn('handleGitHubAutomationWebhook: nothing was posted to GitHub', {
        agentId, where, status: record?.status ?? 'unknown', reason: answer ? 'agent did not complete' : 'agent left no answer',
      });
      return;
    }
    const token = await resolveToken();
    if (!token) {
      logger.warn('handleGitHubAutomationWebhook: the answer was not posted; no GitHub token is configured', { agentId, where });
      return;
    }
    await new GitHubIntegration().postReply(target, answer, token);
    logger.info('handleGitHubAutomationWebhook: posted the agent answer', { agentId, where });
  } catch (error) {
    logger.warn('handleGitHubAutomationWebhook: the answer could not be posted to GitHub', { agentId, where, error: summarizeError(error) });
  }
}
