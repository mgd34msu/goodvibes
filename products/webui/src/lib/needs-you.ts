/**
 * The number on the Work entry in the sidebar.
 *
 * It must be the page's own "Needs you" count, not a second derivation: the page
 * also lists pending approvals that no fleet node carries, ready best-of-N
 * groups (their attempt nodes fold into one row), and it drops an
 * approval-blocked node whose approval already has a row. Counting fleet nodes
 * alone reads high or silent. Only these three sources can put a row in the
 * Needs you group, so only they are read here.
 */
import { buildWorkItems, groupWorkItems, runningNowCount, type WorkSources } from '../views/work/work-items';

export type NeedsYouSources = Pick<WorkSources, 'approvals' | 'nodes' | 'attemptGroups'>;

export function needsYouCount({ approvals, nodes, attemptGroups }: NeedsYouSources): number {
  const items = buildWorkItems({ approvals, nodes, attemptGroups, sessions: [], hosted: [], tasks: [], ciWatches: [] });
  return groupWorkItems(items, 'all').needs.length;
}

export type RunningNowSources = Pick<WorkSources, 'nodes' | 'attemptGroups' | 'tasks'>;

/**
 * What the account menu says is running: the Work page's own count over the
 * sources the shell already reads (the fleet, best-of-N groups, runtime tasks),
 * so the two never disagree about an idle watcher or a schedule between runs.
 */
export function runningNow({ nodes, attemptGroups, tasks }: RunningNowSources): number {
  return runningNowCount(buildWorkItems({ approvals: [], nodes, attemptGroups, sessions: [], hosted: [], tasks, ciWatches: [] }));
}
