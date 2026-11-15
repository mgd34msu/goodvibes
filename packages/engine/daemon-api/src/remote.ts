import type { DaemonRemoteDispatchRouteHandlers } from './context.js';
import { InvalidPathEncodingError, invalidPathEncodingResponse, safeDecodeURIComponent } from './operator.js';

export async function dispatchRemoteRoutes(
  req: Request,
  handlers: DaemonRemoteDispatchRouteHandlers,
): Promise<Response | null> {
  try {
    return await dispatchRemoteRoutesInner(req, handlers);
  } catch (error) {
    if (error instanceof InvalidPathEncodingError) return invalidPathEncodingResponse();
    throw error;
  }
}

/** Ids are matched on the raw path and decoded here, the way the gateway REST table decodes them. */
async function dispatchRemoteRoutesInner(
  req: Request,
  handlers: DaemonRemoteDispatchRouteHandlers,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/remote' && method === 'GET') return handlers.getRemote();
  if (pathname === '/api/remote/pair/requests' && method === 'GET') return handlers.getRemotePairRequests();
  const pairActionMatch = pathname.match(/^\/api\/remote\/pair\/requests\/([^/]+)\/(approve|reject)$/);
  if (pairActionMatch && method === 'POST') {
    return pairActionMatch[2]! === 'approve'
      ? handlers.approveRemotePairRequest(safeDecodeURIComponent(pairActionMatch[1]!), req)
      : handlers.rejectRemotePairRequest(safeDecodeURIComponent(pairActionMatch[1]!), req);
  }
  if (pathname === '/api/remote/peers' && method === 'GET') return handlers.getRemotePeers();
  const peerTokenActionMatch = pathname.match(/^\/api\/remote\/peers\/([^/]+)\/token\/(rotate|revoke)$/);
  if (peerTokenActionMatch && method === 'POST') {
    return peerTokenActionMatch[2]! === 'rotate'
      ? handlers.rotateRemotePeerToken(safeDecodeURIComponent(peerTokenActionMatch[1]!), req)
      : handlers.revokeRemotePeerToken(safeDecodeURIComponent(peerTokenActionMatch[1]!), req);
  }
  const peerDisconnectMatch = pathname.match(/^\/api\/remote\/peers\/([^/]+)\/disconnect$/);
  if (peerDisconnectMatch && method === 'POST') return handlers.disconnectRemotePeer(safeDecodeURIComponent(peerDisconnectMatch[1]!), req);
  const peerInvokeMatch = pathname.match(/^\/api\/remote\/peers\/([^/]+)\/invoke$/);
  if (peerInvokeMatch && method === 'POST') return handlers.invokeRemotePeer(safeDecodeURIComponent(peerInvokeMatch[1]!), req);
  if (pathname === '/api/remote/work' && method === 'GET') return handlers.getRemoteWork();
  const workCancelMatch = pathname.match(/^\/api\/remote\/work\/([^/]+)\/cancel$/);
  if (workCancelMatch && method === 'POST') return handlers.cancelRemoteWork(safeDecodeURIComponent(workCancelMatch[1]!), req);

  return null;
}
