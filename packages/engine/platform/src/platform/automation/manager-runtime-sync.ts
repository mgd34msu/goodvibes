import type { DomainDispatch } from '../runtime/store/index.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';

export function syncAutomationRuntimeSnapshot(
  runtimeDispatch: DomainDispatch | null,
  jobs: Iterable<AutomationJob>,
  runs: Iterable<AutomationRun>,
): void {
  if (!runtimeDispatch) return;
  for (const job of jobs) {
    runtimeDispatch.syncAutomationJob(job, 'automation.bootstrap');
  }
  for (const run of runs) {
    runtimeDispatch.syncAutomationRun(run, 'automation.bootstrap');
  }
}

export function syncAutomationJobToRuntime(
  runtimeDispatch: DomainDispatch | null,
  job: AutomationJob,
  source: string,
): void {
  runtimeDispatch?.syncAutomationJob(job, source);
}

export function syncAutomationRunToRuntime(
  runtimeDispatch: DomainDispatch | null,
  run: AutomationRun,
  source: string,
): void {
  runtimeDispatch?.syncAutomationRun(run, source);
}

export function removeAutomationJobFromRuntime(
  runtimeDispatch: DomainDispatch | null,
  jobId: string,
  source: string,
): void {
  runtimeDispatch?.removeAutomationJob(jobId, source);
}
