import type { DaemonAutomationRouteHandlers } from './context.js';
import { InvalidPathEncodingError, invalidPathEncodingResponse, safeDecodeURIComponent } from './operator.js';

/**
 * Job and schedule create/update/delete/enable/disable, and job pause/resume,
 * are served only by the gateway REST table (`gateway-rest-routes.ts`), which
 * carries the verb gating and the native handlers' revision check; they are
 * deliberately absent here. This table keeps the reads, run actions and the
 * run-now paths.
 */
export async function dispatchAutomationRoutes(
  req: Request,
  handlers: DaemonAutomationRouteHandlers,
): Promise<Response | null> {
  try {
    return await dispatchAutomationRoutesInner(req, handlers);
  } catch (error) {
    if (error instanceof InvalidPathEncodingError) return invalidPathEncodingResponse();
    throw error;
  }
}

async function dispatchAutomationRoutesInner(
  req: Request,
  handlers: DaemonAutomationRouteHandlers,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/review' && method === 'GET') return handlers.getReview();
  if (pathname === '/api/session' && method === 'GET') return handlers.getIntegrationSession();
  if (pathname === '/api/automation' && method === 'GET') return handlers.getIntegrationAutomation();
  if (pathname === '/api/automation/jobs' && method === 'GET') return handlers.getAutomationJobs(url);
  if (pathname === '/api/automation/runs' && method === 'GET') return handlers.getAutomationRuns(url);

  const automationRunMatch = pathname.match(/^\/api\/automation\/runs\/([^/]+)$/);
  if (automationRunMatch && method === 'GET') return handlers.getAutomationRun(safeDecodeURIComponent(automationRunMatch[1]!));

  const automationRunActionMatch = pathname.match(/^\/api\/automation\/runs\/([^/]+)\/(cancel|retry)$/);
  if (automationRunActionMatch && method === 'POST') {
    return handlers.automationRunAction(safeDecodeURIComponent(automationRunActionMatch[1]!), automationRunActionMatch[2]! as 'cancel' | 'retry', req);
  }

  const automationJobRunMatch = pathname.match(/^\/api\/automation\/jobs\/([^/]+)\/run$/);
  if (automationJobRunMatch && method === 'POST') return handlers.runAutomationJobNow(safeDecodeURIComponent(automationJobRunMatch[1]!), req);

  if (pathname === '/api/deliveries' && method === 'GET') return handlers.getDeliveries();
  const deliveryMatch = pathname.match(/^\/api\/deliveries\/([^/]+)$/);
  if (deliveryMatch && method === 'GET') return handlers.getDelivery(safeDecodeURIComponent(deliveryMatch[1]!));

  if (pathname === '/api/automation/schedules' && method === 'GET') return handlers.getSchedules();
  const scheduleRunMatch = pathname.match(/^\/api\/automation\/schedules\/([^/]+)\/run$/);
  if (scheduleRunMatch && method === 'POST') return handlers.runScheduleNow(safeDecodeURIComponent(scheduleRunMatch[1]!), req);

  return null;
}
