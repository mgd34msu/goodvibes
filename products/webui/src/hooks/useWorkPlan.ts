/**
 * useWorkPlan, the project work plan the daemon serves (projectPlanning.workPlan.*).
 *
 * It is the same plan the terminal app, the Agent and the daemon's own
 * `work_plan` tool keep: every GoodVibes program of the user keeps a project's
 * plan in one shared file, and the daemon announces every committed change to it
 * (its own edits, and another program's, which it notices on the file) as a
 * `planner` event carrying the plan's revision.
 *
 * The snapshot is read once, then again only when a planner frame or an edit's
 * answer carries a revision other than the one shown: one integer compare per
 * frame, no polling. While the event lane is down the app-wide fallback
 * (useRealtimeInvalidation) revalidates active queries, this one included.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hasSignInSync, client as platformClient } from '../lib/goodvibes';
import { isClientLifetimeCurrent, type ClientLifetime } from '../lib/client-lifetime';
import { subscribeEvents } from '../lib/event-stream';
import { queryKeys } from '../lib/queries';
import { readInContractScope } from './useContracts';

export type WorkPlanSnapshot = Awaited<ReturnType<typeof platformClient.workPlan.snapshot>>;
export type WorkPlanTask = WorkPlanSnapshot['tasks'][number];
export type WorkPlanTaskStatus = WorkPlanTask['status'];
/** Every edit's answer: what changed, the plan's revision and counts after it. */
export type WorkPlanEdit = Awaited<ReturnType<typeof platformClient.workPlan.tasks.create>>;

/** The plan's revision in a `planner` frame for this project's plan, or null for any other frame. */
export function workPlanFrameRevision(payload: unknown, projectId: string | undefined, workPlanId: string | undefined): number | null {
  const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const inner = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : envelope;
  if (typeof inner.type !== 'string' || !inner.type.startsWith('WORK_PLAN_')) return null;
  if (projectId && typeof inner.projectId === 'string' && inner.projectId !== projectId) return null;
  if (workPlanId && typeof inner.workPlanId === 'string' && inner.workPlanId !== workPlanId) return null;
  return typeof inner.revision === 'number' ? inner.revision : null;
}

export function useWorkPlan(lifetime: ClientLifetime, enabled: boolean) {
  const queryClient = useQueryClient();
  const scope = lifetime.revision;
  const query = useQuery({
    queryKey: queryKeys.workPlanSnapshot(scope),
    queryFn: ({ signal }) => readInContractScope(lifetime, signal, () => platformClient.workPlan.snapshot()),
    enabled: enabled && hasSignInSync() && isClientLifetimeCurrent(lifetime),
    retry: false,
  });

  // What is on screen, for the compare in the frame handler (no re-subscribe per read).
  const shownRef = useRef<{ readonly revision: number; readonly projectId: string; readonly workPlanId: string } | null>(null);
  shownRef.current = query.data
    ? { revision: query.data.revision, projectId: query.data.projectId, workPlanId: query.data.workPlanId }
    : null;

  const reread = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workPlanSnapshot(scope) });
  }, [queryClient, scope]);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeEvents({
      domains: ['planner'],
      events: ['planner'],
      onEvent: (_name, payload) => {
        const shown = shownRef.current;
        const revision = workPlanFrameRevision(payload, shown?.projectId, shown?.workPlanId);
        if (revision !== null && revision !== shown?.revision) reread();
      },
      // Frames may have been missed while the lane was down.
      onReady: (resumed) => { if (resumed) reread(); },
    });
  }, [enabled, reread]);

  /** After an edit: the plan is read again only when the edit moved it past what is shown. */
  const settle = useCallback((edit: { readonly revision: number }) => {
    if (edit.revision !== shownRef.current?.revision) reread();
  }, [reread]);

  return { query, settle, reread };
}
