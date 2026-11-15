/**
 * ci-watch/gh-source.ts
 *
 * A CiStatusSource backed by the `gh` CLI. It reads PER-JOB check results from
 * the GitHub Checks API (repos/{repo}/commits/{ref}/check-runs), which is the
 * per-job conclusion surface the doctrine requires, never a single rollup.
 * The workflow runs on the commit (actions/runs?head_sha=) say only whether
 * the run is over: a job waiting on another has no check run yet.
 *
 * SHELL SAFETY: every `gh` invocation runs through execFile (no shell) with a
 * hard timeout, so a hung or slow gh call cannot wedge the caller.
 *
 * continue-on-error detection: the check-runs API does not expose whether a job
 * was configured continue-on-error (that lives in the workflow YAML). This
 * source therefore leaves `continueOnError` unset; the report's ban still fires
 * for any source that CAN supply the flag. This limitation is stated, not hidden.
 */
import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { CiTargetGoneError, type CiJob, type CiStatusSource, type CiWorkflowRun } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface GhCheckRun {
  readonly id?: number;
  readonly head_sha?: string;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly html_url?: string;
}

/** Bound the seeded brief: at most this many failing jobs' logs... */
const MAX_LOG_JOBS = 5;
/** ...and at most this many bytes of each job's log, tailed (failures live at the end). */
const MAX_JOB_LOG_BYTES = 16 * 1024;

/** The tail of a job log, bounded and cut on a line boundary. */
function tailLog(raw: string): string {
  const trimmed = raw.trimEnd();
  if (trimmed.length <= MAX_JOB_LOG_BYTES) return trimmed;
  const tail = trimmed.slice(-MAX_JOB_LOG_BYTES);
  const firstNewline = tail.indexOf('\n');
  return `… (truncated to the last ${MAX_JOB_LOG_BYTES} bytes)\n${firstNewline > -1 ? tail.slice(firstNewline + 1) : tail}`;
}


interface GhWorkflowRun {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly html_url?: string;
}

/**
 * The repo, ref and PR number were refused at the service's entry when they
 * could steer this path (`git-names.ts`); here each ref segment is encoded.
 */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

const HEAD_SHA = /^[0-9a-f]{7,64}$/i;

/** `--paginate --jq '.<list>'` emits one JSON array per page; join them. */
function parsePagedList<T>(out: string, list: string): T[] {
  const chunks = out.trim().split('\n').filter((line) => line.trim().length > 0);
  return chunks.flatMap((chunk) => {
    const parsed: unknown = JSON.parse(chunk);
    if (!Array.isArray(parsed)) throw new Error(`the response had no ${list} list`);
    return parsed as T[];
  });
}

/** A failed `gh api` call, with the HTTP status gh reports as `(HTTP nnn)` when the API answered. */
class GhApiError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message);
    this.name = 'GhApiError';
  }
}

function runGh(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const status = /\(HTTP (\d{3})\)/.exec(String(stderr ?? ''))?.[1];
        reject(new GhApiError(`gh ${args[0]} failed: ${summarizeError(error)}`, status ? Number(status) : undefined));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 404 (no such repo or PR, or not readable with this login) and 422 (no
 * commit for the ref: the branch was deleted) mean no verdict will ever come.
 */
async function readTarget(args: readonly string[], timeoutMs: number, what: string): Promise<string> {
  try {
    return await runGh(args, timeoutMs);
  } catch (error) {
    if (error instanceof GhApiError && (error.status === 404 || error.status === 422)) {
      throw new CiTargetGoneError(`GitHub has no ${what} (HTTP ${error.status})`, error.status);
    }
    throw error;
  }
}

function toCiJob(run: GhCheckRun): CiJob {
  const status = run.status === 'completed' || run.status === 'in_progress' || run.status === 'queued'
    ? run.status
    : 'in_progress';
  const identity = run.html_url?.match(/\/actions\/runs\/(\d+)\/job\/(\d+)(?:[?#/]|$)/);
  return {
    ...(run.head_sha ? { headSha: run.head_sha } : {}),
    ...(identity ? { runId: identity[1]!, jobId: identity[2]! } : {}),
    name: run.name ?? 'unnamed check',
    status,
    conclusion: run.conclusion ?? null,
    ...(run.html_url ? { url: run.html_url } : {}),
  };
}

export interface GhCliCiSourceOptions {
  readonly timeoutMs?: number | undefined;
}

/** Build a gh-CLI-backed CI status source. */
export function createGhCliCiSource(options: GhCliCiSourceOptions = {}): CiStatusSource {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  async function resolveRef(repo: string, ref?: string, prNumber?: number): Promise<string> {
    if (prNumber !== undefined) {
      const out = await readTarget(['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.head.sha'], timeoutMs, `pull request #${prNumber} in ${repo} that this login can read`);
      const sha = out.trim();
      if (!sha) throw new Error(`could not resolve head sha for ${repo} PR #${prNumber}`);
      return sha;
    }
    if (ref) return refPath(ref);
    throw new Error('a ref or prNumber is required to resolve CI status');
  }

  return {
    fetchJobs: async ({ repo, ref, prNumber }): Promise<readonly CiJob[]> => {
      const resolvedRef = await resolveRef(repo, ref, prNumber);
      const out = await readTarget(
        ['api', `repos/${repo}/commits/${resolvedRef}/check-runs`, '--paginate', '--jq', '.check_runs'],
        timeoutMs,
        prNumber !== undefined ? `commit for pull request #${prNumber} in ${repo}` : `commit for "${ref}" in ${repo} that this login can read`,
      );
      let runs: GhCheckRun[];
      try {
        runs = parsePagedList<GhCheckRun>(out, 'check_runs');
      } catch (error) {
        throw new Error(`could not parse gh check-runs output: ${summarizeError(error)}`);
      }
      return runs.map(toCiJob);
    },
    fetchWorkflowRuns: async ({ repo, headSha }): Promise<readonly CiWorkflowRun[]> => {
      if (!HEAD_SHA.test(headSha)) throw new Error(`"${headSha}" is not a commit sha`);
      let out: string;
      try {
        out = await runGh(['api', `repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`, '--paginate', '--jq', '.workflow_runs'], timeoutMs);
      } catch (error) {
        // Actions not available on the repository: there is no run to wait for.
        if (error instanceof GhApiError && error.status === 404) return [];
        throw error;
      }
      let runs: GhWorkflowRun[];
      try {
        runs = parsePagedList<GhWorkflowRun>(out, 'workflow_runs');
      } catch (error) {
        throw new Error(`could not parse gh workflow-runs output: ${summarizeError(error)}`);
      }
      return runs.map((run) => ({
        name: run.name ?? 'unnamed workflow',
        status: run.status ?? 'in_progress',
        conclusion: run.conclusion ?? null,
        ...(run.html_url ? { url: run.html_url } : {}),
      }));
    },
    fetchFailureLogs: async ({ repo, ref, prNumber, jobNames, jobs }): Promise<string> => {
      // Seed the fix-session with the ACTUAL failing logs, bounded: the
      // check-run id doubles as the Actions job id, whose log endpoint
      // (repos/{repo}/actions/jobs/{id}/logs) serves the raw text. Each log is
      // tailed (failures live at the end) and the job count is capped so the
      // brief stays a brief. Any per-job fetch failure degrades to an honest
      // pointer line for that job, never a fabricated log, never fatal.
      const target = prNumber !== undefined ? `PR #${prNumber}` : (ref ?? 'the ref');
      logger.info('ci-watch: composing failure brief', { repo, target, jobCount: jobNames.length });
      const header = [
        `CI failed for ${repo} (${target}).`,
        `Failing jobs: ${jobNames.join(', ') || 'unknown'}.`,
      ];
      if (jobs !== undefined) {
        const sections: string[] = [];
        for (const job of jobs.slice(0, MAX_LOG_JOBS)) {
          if (!job.jobId || !/^[0-9]+$/.test(job.jobId)) { sections.push(`--- ${job.name}: exact Actions job identity unavailable ---`); continue; }
          try { sections.push(`--- ${job.name} (job ${job.jobId}, log tail) ---\n${tailLog(await runGh(['api', `repos/${repo}/actions/jobs/${job.jobId}/logs`], timeoutMs))}`); }
          catch (error) { sections.push(`--- ${job.name}: log fetch failed (${summarizeError(error)}) ---`); }
        }
        if (jobs.length > MAX_LOG_JOBS) sections.push(`(+${jobs.length - MAX_LOG_JOBS} more failing jobs, logs omitted)`);
        return [...header, '', ...sections].join('\n');
      }
      // Historical direct callers without a captured status retain compatibility lookup.
      try {
        const resolvedRef = await resolveRef(repo, ref, prNumber);
        const out = await runGh(
          ['api', `repos/${repo}/commits/${resolvedRef}/check-runs`, '--paginate', '--jq', '.check_runs'],
          timeoutMs,
        );
        const runs = parsePagedList<GhCheckRun>(out, 'check_runs');
        const wanted = new Set(jobNames);
        const failingRuns = runs.filter((run) => run.id !== undefined && run.name !== undefined && wanted.has(run.name));
        const sections: string[] = [];
        for (const run of failingRuns.slice(0, MAX_LOG_JOBS)) {
          try {
            const raw = await runGh(['api', `repos/${repo}/actions/jobs/${run.id}/logs`], timeoutMs);
            sections.push(`--- ${run.name} (log tail) ---\n${tailLog(raw)}`);
          } catch (error) {
            sections.push(`--- ${run.name}: log fetch failed (${summarizeError(error)}); expand with: gh run view --log-failed (in a clone of ${repo}) ---`);
          }
        }
        if (failingRuns.length > MAX_LOG_JOBS) {
          sections.push(`(+${failingRuns.length - MAX_LOG_JOBS} more failing jobs, logs omitted to keep the brief bounded)`);
        }
        if (sections.length > 0) return [...header, '', ...sections].join('\n');
      } catch (error) {
        logger.warn('ci-watch: failing-job log fetch failed; seeding the pointer brief instead', {
          repo, target, error: summarizeError(error),
        });
      }
      return [
        ...header,
        `Fetch full logs with: gh run view --log-failed (in a clone of ${repo}).`,
      ].join('\n');
    },
  };
}
