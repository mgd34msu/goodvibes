/**
 * ci-watch/report.ts
 *
 * Derives the overall CI verdict from the PER-JOB conclusions, the whole point
 * of the doctrine. It never trusts a single rollup status. continue-on-error
 * jobs are recorded as violations and, because they are banned, force the verdict
 * off "passed" even if every visible conclusion is success (a continue-on-error
 * job can be green while having masked a real failure).
 */
import {
  FAILING_CONCLUSIONS,
  PASSING_CONCLUSIONS,
  type CiJob,
  type CiOverall,
  type CiReport,
  type CiWorkflowRun,
} from './types.js';

export interface DeriveCiReportInput {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly jobs: readonly CiJob[];
  /**
   * The workflow runs on the jobs' commit, when the source can list them. A
   * job that waits on another has no check run until it starts, so every job
   * passing says nothing about the run being over; only these runs do.
   */
  readonly workflowRuns?: readonly CiWorkflowRun[] | undefined;
  readonly now?: number | undefined;
}

/** Build the per-job report + derived verdict. */
export function deriveCiReport(input: DeriveCiReportInput): CiReport {
  const jobs = Object.freeze(input.jobs.map(job => Object.freeze({ ...job })));
  const violations: string[] = [];

  for (const job of jobs) {
    if (job.continueOnError) {
      violations.push(`job "${job.name}" is continue-on-error, which is banned, it can mask a failure`);
    }
    if (job.status === 'completed' && job.conclusion !== null
      && !FAILING_CONCLUSIONS.has(job.conclusion) && !PASSING_CONCLUSIONS.has(job.conclusion)) {
      violations.push(`job "${job.name}" has an unrecognized conclusion "${job.conclusion}", treated as not-passed`);
    }
  }

  const overall = settleOnWorkflowRuns(deriveOverall(jobs, violations.length > 0), input.workflowRuns, violations);
  return {
    repo: input.repo,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    overall,
    jobs,
    violations,
    checkedAt: input.now ?? Date.now(),
  };
}

/**
 * The verdict, per-job:
 *  - no jobs at all -> unknown (never silently "passed").
 *  - any job not yet completed -> pending.
 *  - any completed job whose conclusion is not an explicit pass -> failed.
 *  - a continue-on-error/unknown-conclusion violation -> never "passed".
 *  - otherwise (every job completed and explicitly passing) -> passed.
 */
export function deriveOverall(jobs: readonly CiJob[], hasBlockingViolation: boolean): CiOverall {
  if (jobs.length === 0) return 'unknown';
  if (jobs.some((j) => j.status !== 'completed' || j.conclusion === null)) return 'pending';
  const anyFailing = jobs.some((j) => !PASSING_CONCLUSIONS.has(j.conclusion ?? ''));
  if (anyFailing) return 'failed';
  if (hasBlockingViolation) return 'failed';
  return 'passed';
}

/**
 * A per-job `passed` stands only when every workflow run on the commit has
 * completed. A run that ended badly with no failing job listed (a workflow
 * that failed to start, or one waiting on approval) makes the verdict
 * `failed` and says which. Never turns anything green.
 */
function settleOnWorkflowRuns(overall: CiOverall, runs: readonly CiWorkflowRun[] | undefined, violations: string[]): CiOverall {
  if (overall !== 'passed' || runs === undefined) return overall;
  if (runs.some((run) => run.status !== 'completed')) return 'pending';
  const ended = runs.filter((run) => !PASSING_CONCLUSIONS.has(run.conclusion ?? ''));
  for (const run of ended) {
    violations.push(`workflow "${run.name}" ended "${run.conclusion ?? 'without a conclusion'}" and lists no failing job`);
  }
  return ended.length > 0 ? 'failed' : 'passed';
}

/** The jobs that did not pass (for notifications and fix-session briefs). */
export function failingJobs(report: CiReport): readonly CiJob[] {
  return report.jobs.filter((j) => j.status === 'completed' && (j.continueOnError || !PASSING_CONCLUSIONS.has(j.conclusion ?? '')));
}

/** The names of the jobs that did not pass. */
export function failingJobNames(report: CiReport): string[] {
  return failingJobs(report).map((j) => j.name);
}

/**
 * A job GitHub Actions ran, identified down to its commit, run and job. Only
 * such a job's log can be read and its failure repaired from here; a check
 * posted by another app has none of the three.
 */
export function hasActionsIdentity(job: CiJob): boolean {
  return Boolean(job.headSha && job.runId && job.jobId);
}

/** A compact one-line-per-job rendering for a channel notification. */
export function renderCiReportLines(report: CiReport): string {
  const header = `CI ${report.overall.toUpperCase()} for ${report.repo}${report.ref ? `@${report.ref}` : ''}${report.prNumber ? ` (PR #${report.prNumber})` : ''}`;
  const jobLines = report.jobs.map((j) => `- ${j.name}: ${j.status === 'completed' ? (j.conclusion ?? 'no-conclusion') : j.status}`);
  const violationLines = report.violations.map((v) => `! ${v}`);
  return [header, ...jobLines, ...violationLines].join('\n');
}
