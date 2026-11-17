import type { DaemonTaskRouteHandlers } from './context.js';
import { InvalidPathEncodingError, invalidPathEncodingResponse, safeDecodeURIComponent } from './operator.js';
import { readBoundedPositiveInteger } from './route-helpers.js';

export async function dispatchTaskRoutes(
  req: Request,
  handlers: DaemonTaskRouteHandlers,
): Promise<Response | null> {
  try {
    return await dispatchTaskRoutesInner(req, handlers);
  } catch (error) {
    if (error instanceof InvalidPathEncodingError) return invalidPathEncodingResponse();
    throw error;
  }
}

/** Ids are matched on the raw path and decoded here, the way the gateway REST table decodes them. */
async function dispatchTaskRoutesInner(
  req: Request,
  handlers: DaemonTaskRouteHandlers,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/task' && method === 'POST') return handlers.postTask(req);
  // GET /task is intentionally left to extension routers that expose
  // surface-specific task status pages.
  if (pathname === '/task' && method === 'GET') return null;

  if (pathname === '/api/tasks' && method === 'GET') {
    const limit = url.searchParams.get('limit');
    return handlers.getIntegrationTasks(limit === null ? undefined : readBoundedPositiveInteger(limit, 500, 5_000));
  }
  const taskDetailMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskDetailMatch && method === 'GET') return handlers.getRuntimeTask(safeDecodeURIComponent(taskDetailMatch[1]!));

  const taskActionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|retry)$/);
  if (taskActionMatch && method === 'POST') {
    return handlers.runtimeTaskAction(safeDecodeURIComponent(taskActionMatch[1]!), taskActionMatch[2]! as 'cancel' | 'retry', req);
  }

  const taskStatusMatch = pathname.match(/^\/task\/([^/]+)$/);
  if (taskStatusMatch && method === 'GET') return handlers.getTaskStatus(safeDecodeURIComponent(taskStatusMatch[1]!));

  return null;
}
