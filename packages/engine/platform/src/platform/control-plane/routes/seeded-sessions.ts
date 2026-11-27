import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { ciRepairPrompt } from '../../ci-watch/repair-prompt.js';
/**
 * routes/seeded-sessions.ts
 *
 * The ONE seeded-session recipe (an at-now, delete-after-run automation job
 * pinned to a fresh service session, returning the REAL attachable session id)
 * and its two producers: the CI fix session and the merge-conflict resolution
 * session. Split out of register-gateway-verb-groups.ts, which re-exports
 * startCiFixSession for compatibility.
 */
import { randomUUID } from 'node:crypto';
import type { AutomationManager } from '../../automation/index.js';
import type { FixSessionBrief, FixSessionStartOutcome } from '../../ci-watch/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';

/** What the seeded-session recipe needs from the automation manager; `removeJob` is optional so a narrower host still works. */
type SeededSessionAutomation = Pick<AutomationManager, 'createJob' | 'runNow'> & Partial<Pick<AutomationManager, 'removeJob'>>;

/**
 * The job is created disabled and only ever runs through `runNow`, so a start
 * that failed leaves a job nothing will run or delete (`deleteAfterRun` fires
 * only after a run). Remove it so retries do not pile up dead jobs.
 */
async function discardUnstartedJob(automation: SeededSessionAutomation, jobId: string): Promise<void> {
  try {
    await automation.removeJob?.(jobId);
  } catch (error) {
    logger.warn('A seeded session job that never started could not be removed', { jobId, error: summarizeError(error) });
  }
}

/**
 * Start a one-shot fix-session pre-briefed with the failing CI jobs, and
 * return the REAL spawned session's id, the id session attach/resume
 * resolves. The automation job id ('auto-…') is a scheduling handle no
 * attach can resolve and must never be surfaced as the fix session; this is
 * pinned by test (job-id vs session-id confusion).
 *
 * Mechanics: the job is created DISABLED (the scheduler can never race a
 * second run) and executed immediately via runNow, whose returned run
 * carries the spawned ids. The job targets a pinned FRESH shared session
 * (never the operator's own preferred session), so the fix work lives in a
 * real attachable session with the spawned agent bound to it. A start that
 * produces no attachable session is an honest error outcome, never a dead id.
 */
export async function startCiFixSession(
  automation: SeededSessionAutomation,
  brief: FixSessionBrief,
): Promise<FixSessionStartOutcome> {
  const operation = currentExternalOperationSource();
  // The repair works in the watch's project; a watch that names none has no folder to work in (never the daemon's own).
  if (!brief.project) return { error: `The CI repair for ${brief.repo} was not started: its watch names no project to work in.`, refused: true };
  const prompt = ciRepairPrompt(brief);
  let createdJobId: string | undefined;
  try {
    const job = await automation.createJob({
      name: `Fix CI: ${brief.repo}`,
      ...(operation ? { requiresSourceOwner: true } : {}),
      prompt,
      // Its run works in the watch's project (the project of the turn whose push made the watch).
      workingDirectory: brief.project,
      schedule: { kind: 'at', at: Date.now() },
      target: {
        kind: 'main',
        sessionId: `ci-fix-${randomUUID().slice(0, 10)}`,
        surfaceKind: 'service',
        createIfMissing: true,
      },
      enabled: false,
      deleteAfterRun: true,
    });
    createdJobId = job.id;
    operation?.assertCurrent(); operation?.signal?.throwIfAborted();
    const run = await automation.runNow(job.id, operation);
    if (run.sessionId) return { sessionId: run.sessionId };
    return { error: `the fix run started without an attachable session (run ${run.id}, status ${run.status})` };
  } catch (error) {
    if (createdJobId) await discardUnstartedJob(automation, createdJobId);
    // Automation subsystem disabled, concurrency ceiling, or spawn failure,
    // the honest failure travels instead of a dead id.
    return { error: summarizeError(error) };
  }
}

/** Every conflict-resolution session id starts with this, so a completion can be recognised without a lookup. */
export const CONFLICT_RESOLUTION_SESSION_PREFIX = 'conflict-fix-';

/**
 * Start a merge-conflict resolution session INSIDE the kept worktree, the
 * same seeded-session machinery as startCiFixSession, seeded with the tree
 * path, item branch, and the STRUCTURED conflict list. Returns the REAL
 * session id plus the job id, or an honest error. The run-completion hook
 * finds the item by that session id (stamped on the item) to re-attempt the
 * merge and reclaim the tree.
 */
export async function startConflictResolutionSession(
  automation: SeededSessionAutomation,
  seed: {
    readonly workstreamId: string;
    readonly itemId: string;
    readonly title: string;
    readonly worktreePath: string;
    readonly branch: string | undefined;
    readonly files: readonly string[];
  },
  /** Called with the job id and its session id before it runs, so a completion that arrives during `runNow` is not missed. */
  onJobCreated?: (jobId: string, sessionId: string) => void,
): Promise<{ sessionId: string; jobId: string; runId: string } | { error: string }> {
  const prompt = [
    `Merge conflict: "${seed.title}" could not merge into the base branch.`,
    `Kept worktree: ${seed.worktreePath}`,
    ...(seed.branch ? [`Item branch: ${seed.branch}`] : []),
    `Conflicting files:`,
    ...(seed.files.length > 0 ? seed.files.map((file) => `- ${file}`) : ['- (unknown, inspect the tree)']),
    '',
    `Work INSIDE the kept worktree at ${seed.worktreePath}. Resolve the conflicts against the base branch, keep both sides' intent, and commit the resolution onto the item branch. Do not delete the branch or the worktree, once your resolution lands, the merge is re-attempted and the tree is reclaimed automatically.`,
  ].join('\n');
  let createdJobId: string | undefined;
  const sessionId = `${CONFLICT_RESOLUTION_SESSION_PREFIX}${randomUUID().slice(0, 10)}`;
  try {
    const job = await automation.createJob({
      name: `Resolve merge conflict: ${seed.title}`,
      prompt,
      // Its run works in the kept worktree (its project's), never the daemon's own folder.
      workingDirectory: seed.worktreePath,
      schedule: { kind: 'at', at: Date.now() },
      target: {
        kind: 'main',
        sessionId,
        surfaceKind: 'service',
        createIfMissing: true,
      },
      enabled: false,
      deleteAfterRun: true,
    });
    createdJobId = job.id;
    onJobCreated?.(job.id, sessionId);
    const run = await automation.runNow(job.id);
    if (run.sessionId) return { sessionId: run.sessionId, jobId: job.id, runId: run.id };
    return { error: `the resolution run started without an attachable session (run ${run.id}, status ${run.status})` };
  } catch (error) {
    if (createdJobId) await discardUnstartedJob(automation, createdJobId);
    return { error: summarizeError(error) };
  }
}
