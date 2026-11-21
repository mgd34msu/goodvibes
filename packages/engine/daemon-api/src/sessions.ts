import type { DaemonSessionRouteHandlers } from './context.js';
import { InvalidPathEncodingError, invalidPathEncodingResponse, safeDecodeURIComponent } from './operator.js';

export async function dispatchSessionRoutes(
  req: Request,
  handlers: DaemonSessionRouteHandlers,
): Promise<Response | null> {
  try {
    return await dispatchSessionRoutesInner(req, handlers);
  } catch (error) {
    if (error instanceof InvalidPathEncodingError) return invalidPathEncodingResponse();
    throw error;
  }
}

/** Ids are matched on the raw path and decoded here, the way the gateway REST table decodes them. */
async function dispatchSessionRoutesInner(
  req: Request,
  handlers: DaemonSessionRouteHandlers,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/sessions' && method === 'GET') return handlers.getIntegrationSessions(url, req);
  if (pathname === '/api/sessions/register' && method === 'POST') return handlers.registerSharedSession(req);
  if (pathname === '/api/sessions' && method === 'POST') return handlers.createSharedSession(req);

  const sharedSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sharedSessionMatch && method === 'GET') return handlers.getSharedSession(safeDecodeURIComponent(sharedSessionMatch[1]!), req);
  if (sharedSessionMatch && method === 'DELETE') return handlers.deleteSharedSession(safeDecodeURIComponent(sharedSessionMatch[1]!), req);

  const sharedSessionLifecycleMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(close|reopen|detach)$/);
  if (sharedSessionLifecycleMatch && method === 'POST') {
    const [, rawSessionId, action] = sharedSessionLifecycleMatch;
    const sessionId = safeDecodeURIComponent(rawSessionId!);
    if (action === 'close') return handlers.closeSharedSession(sessionId, req);
    if (action === 'reopen') return handlers.reopenSharedSession(sessionId, req);
    return handlers.detachSharedSession(sessionId, req);
  }

  const sharedSessionMessagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sharedSessionMessagesMatch && method === 'GET') return handlers.getSharedSessionMessages(safeDecodeURIComponent(sharedSessionMessagesMatch[1]!), url, req);
  if (sharedSessionMessagesMatch && method === 'POST') return handlers.postSharedSessionMessage(safeDecodeURIComponent(sharedSessionMessagesMatch[1]!), req);

  const sharedSessionInputsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs$/);
  if (sharedSessionInputsMatch && method === 'GET') return handlers.getSharedSessionInputs(safeDecodeURIComponent(sharedSessionInputsMatch[1]!), url);

  const sharedSessionSteerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (sharedSessionSteerMatch && method === 'POST') return handlers.postSharedSessionSteer(safeDecodeURIComponent(sharedSessionSteerMatch[1]!), req);

  const sharedSessionFollowUpMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/follow-up$/);
  if (sharedSessionFollowUpMatch && method === 'POST') return handlers.postSharedSessionFollowUp(safeDecodeURIComponent(sharedSessionFollowUpMatch[1]!), req);

  const sharedSessionCancelInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs\/([^/]+)\/cancel$/);
  if (sharedSessionCancelInputMatch && method === 'POST') {
    return handlers.cancelSharedSessionInput(safeDecodeURIComponent(sharedSessionCancelInputMatch[1]!), safeDecodeURIComponent(sharedSessionCancelInputMatch[2]!), req);
  }

  const sharedSessionDeliverInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs\/([^/]+)\/deliver$/);
  if (sharedSessionDeliverInputMatch && method === 'POST') {
    return handlers.deliverSharedSessionInput(safeDecodeURIComponent(sharedSessionDeliverInputMatch[1]!), safeDecodeURIComponent(sharedSessionDeliverInputMatch[2]!), req);
  }

  const sharedSessionEventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (sharedSessionEventsMatch && method === 'GET') return handlers.getSharedSessionEvents(safeDecodeURIComponent(sharedSessionEventsMatch[1]!), req);

  return null;
}
