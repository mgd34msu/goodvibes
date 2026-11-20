import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { GitHubIntegration, type GitHubReplyTarget } from '../../integrations/github.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { AgentRecord } from '../../tools/agent/index.js';
import type { TrySpawnAgentFn } from '../types.js';
import { parseJsonRecord, readRecord, readString, readTextBodyWithinLimit } from '../helpers.js';
import { inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { done, failedOutcome, observe, refusal } from '@goodvibes-jev/engine/errors';
import { effectKey, newOperationId, outcomeOfFailure, type OperationId } from '../../state/operation.js';
import type { OperationLog } from '../../state/operation-log.js';

/** An answer owed to an issue or pull request: accepted before GitHub is answered, so a restart reports or finishes it. */
export interface GitHubReplyOwed {
  readonly target: GitHubReplyTarget;
  readonly agentId: string;
}
/** The answer itself, recorded before it is posted, so a post a restart cut short is finished with the same marker. */
export interface GitHubReplyPost {
  readonly target: GitHubReplyTarget;
  readonly body: string;
}
export type GitHubReplyOperation = GitHubReplyOwed | GitHubReplyPost;
const REPLY_KIND = 'github.reply';
const POST_KIND = 'github.reply.post';

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
    /** The daemon's operation log: an owed answer is accepted there before GitHub hears "queued". */
    readonly operations?: OperationLog<GitHubReplyOperation> | undefined;
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
      if (decision.reply && context.awaitAgent) {
        // Save, then acknowledge: the owed answer is on disk before GitHub is told it will come.
        const op = newOperationId('github-reply');
        if (context.operations) {
          await context.operations.accept({ op, kind: REPLY_KIND, payload: { target: decision.reply, agentId: spawnResult.id } });
        }
        void postAgentAnswer({ operations: context.operations, awaitAgent: context.awaitAgent, resolveToken }, op, spawnResult.id, decision.reply);
      }
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

interface ReplyDeps {
  readonly operations?: OperationLog<GitHubReplyOperation> | undefined;
  readonly awaitAgent: (agentId: string) => Promise<AgentRecord | null>;
  readonly resolveToken: () => Promise<string | null>;
}

/** The hidden line a posted answer carries, by which a post after a restart finds one that already landed. */
function replyMarker(op: OperationId): string {
  return `<!-- goodvibes:op=${op} -->`;
}

/**
 * Posts a finished agent's answer to the issue or pull request its event came
 * from. Runs after GitHub was answered; a failure is logged and settled on the
 * operation, never thrown. The answer is recorded (its own operation, with the
 * body) before the post, so a restart in the middle posts it once.
 */
async function postAgentAnswer(deps: ReplyDeps, op: OperationId, agentId: string, target: GitHubReplyTarget): Promise<void> {
  const where = `${target.owner}/${target.repo}#${target.number}`;
  const ops = deps.operations;
  const fail = (reason: string): void => {
    logger.warn('handleGitHubAutomationWebhook: nothing was posted to GitHub', { agentId, where, reason });
    ops?.settle(op, failedOutcome(refusal({ code: 'NOT_POSTED', state: 'nothing was posted', reason, next: ['Ask again on the issue or pull request'], retryable: false })));
  };
  try {
    const record = await deps.awaitAgent(agentId);
    const answer = record?.fullOutput?.trim();
    if (record?.status !== 'completed' || !answer) {
      fail(record ? (answer ? `the agent ended ${record.status}` : 'the agent left no answer') : 'the agent is not known to this daemon (it stopped with an earlier daemon)');
      return;
    }
    const post = effectKey(op, 'post') as string as OperationId;
    if (ops) {
      await ops.accept({ op: post, kind: POST_KIND, payload: { target, body: answer } });
      ops.settle(op, done((await observe('the answer was produced and recorded for posting', () => post))!));
    }
    await postRecordedAnswer(deps, post, target, answer, Date.now(), false);
  } catch (error) {
    fail(summarizeError(error));
  }
}

/**
 * Posts a recorded answer with its marker and settles its operation. After a
 * restart (`checkFirst`) the issue's comments are read once for the marker, so
 * an answer whose post landed before the restart is not posted again.
 */
async function postRecordedAnswer(deps: ReplyDeps, post: OperationId, target: GitHubReplyTarget, body: string, sinceMs: number, checkFirst: boolean): Promise<void> {
  const where = `${target.owner}/${target.repo}#${target.number}`;
  const ops = deps.operations;
  const token = await deps.resolveToken();
  if (!token) {
    logger.warn('handleGitHubAutomationWebhook: the answer was not posted; no GitHub token is configured', { where });
    ops?.settle(post, failedOutcome(refusal({ code: 'NOT_POSTED', state: 'nothing was posted', reason: 'no GitHub token is configured', next: ['Configure the GitHub token, then ask again'], retryable: false })));
    return;
  }
  const github = new GitHubIntegration();
  const marker = replyMarker(post);
  try {
    if (checkFirst && await github.hasReplyWithMarker(target, marker, sinceMs, token)) {
      ops?.settle(post, done((await observe(`a reply carrying ${marker} is on ${where}`, () => true))!));
      logger.info('handleGitHubAutomationWebhook: the answer was already posted before the restart', { where });
      return;
    }
    await github.postReply(target, `${body}\n\n${marker}`, token);
    ops?.settle(post, done((await observe(`GitHub accepted the reply on ${where}`, () => true))!));
    logger.info('handleGitHubAutomationWebhook: posted the agent answer', { where });
  } catch (error) {
    const outcome = outcomeOfFailure(error, 'sent', effectKey(post, 'comment'), `Look on ${where} for a reply ending with ${marker}`);
    ops?.settle(post, outcome);
    logger.warn('handleGitHubAutomationWebhook: the answer could not be posted to GitHub', { where, outcome: outcome.state, error: summarizeError(error) });
  }
}

/**
 * At start-up: every GitHub answer owed before a restart is finished or
 * reported. A recorded answer is posted (after one read for its marker, so a
 * post that landed is not repeated); an owed answer whose agent stopped with
 * the previous daemon cannot be produced, and is settled failed with that
 * reason and logged. Reads the open lines of the log once.
 */
export async function recoverGitHubReplies(deps: ReplyDeps & { readonly operations: OperationLog<GitHubReplyOperation> }): Promise<void> {
  for (const line of deps.operations.open(POST_KIND)) {
    const payload = line.payload as GitHubReplyPost | undefined;
    if (!payload?.target || typeof payload.body !== 'string') continue;
    await postRecordedAnswer(deps, line.op, payload.target, payload.body, line.at, true);
  }
  for (const line of deps.operations.open(REPLY_KIND)) {
    const payload = line.payload as GitHubReplyOwed | undefined;
    if (!payload?.target || typeof payload.agentId !== 'string') continue;
    void postAgentAnswer(deps, line.op, payload.agentId, payload.target);
  }
}
