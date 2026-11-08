/** Native debugger discovery and diagnostics; no browser execution authority. */
export function debuggerWebSocket(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && url.hostname && !url.hash ? value : null;
  } catch { return null; }
}

/**
 * Endpoints to try for an attach, in order.
 *
 * A browser started with --remote-debugging-port may end up listening on IPv6
 * loopback only, in which case connecting to 127.0.0.1 hangs until it times
 * out. Accepting a bare port number and trying both loopback families turns a
 * confusing 30-second stall into a connection that just works.
 */
export function cdpEndpointCandidates(endpoint: string): readonly string[] {
  const trimmed = endpoint.trim();
  const bare = /^\d+$/.test(trimmed) ? trimmed : null;
  if (bare) return [`http://127.0.0.1:${bare}`, `http://[::1]:${bare}`];
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return [trimmed];
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  } catch {
    return [trimmed];
  }
  // A proxy route, query capability or credentials select a specific debugger.
  // Dropping them and probing only the origin could attach another browser.
  if (parsed.pathname !== '/' || parsed.search || parsed.username || parsed.password) return [parsed.href];
  const port = parsed.port || '9222';
  const host = parsed.hostname;
  const alternates = host === '127.0.0.1' || host === 'localhost'
    ? [`http://127.0.0.1:${port}`, `http://[::1]:${port}`]
    : host === '::1'
      ? [`http://[::1]:${port}`, `http://127.0.0.1:${port}`]
      : [parsed.origin];
  return [...new Set([parsed.origin, ...alternates])];
}

export interface ReachableCdpEndpoint {
  readonly endpoint: string;
  readonly webSocketDebuggerUrl: string | null;
}

/** Finds which candidate endpoint actually has a browser behind it. */
export async function firstReachableCdpEndpoint(candidates: readonly string[], signal?: AbortSignal): Promise<ReachableCdpEndpoint | null> {
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (candidate.startsWith('ws://') || candidate.startsWith('wss://')) {
      const webSocketDebuggerUrl = debuggerWebSocket(candidate);
      if (webSocketDebuggerUrl) return { endpoint: candidate, webSocketDebuggerUrl };
      continue;
    }
    try {
      const discovery = new URL(candidate);
      discovery.pathname = `${discovery.pathname.replace(/\/$/, '')}/json/version`;
      const response = await fetch(discovery, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2_500)]) : AbortSignal.timeout(2_500),
      });
      if (!response.ok) continue;
      const payload = await response.json() as { readonly webSocketDebuggerUrl?: unknown };
      signal?.throwIfAborted();
      const webSocketDebuggerUrl = debuggerWebSocket(payload.webSocketDebuggerUrl);
      if (!webSocketDebuggerUrl) continue;
      return {
        endpoint: candidate,
        webSocketDebuggerUrl,
      };
    } catch {
      signal?.throwIfAborted();
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Whether a plain WebSocket can complete the debugger handshake this runtime's
 * HTTP client could not. When this succeeds and the driver still failed, the
 * browser is fine and the limitation is ours, which is what the caller is
 * told, instead of a message implying they set something up wrong.
 */
export async function cdpWebSocketHandshakeWorks(webSocketDebuggerUrl: string | null): Promise<boolean> {
  if (!webSocketDebuggerUrl) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean, socket?: WebSocket): void => {
      if (settled) return;
      settled = true;
      try {
        socket?.close();
      } catch {
        // Closing a socket that never opened is not an error.
      }
      resolve(value);
    };
    try {
      const socket = new WebSocket(webSocketDebuggerUrl);
      socket.onopen = () => {
        finish(true, socket);
      };
      socket.onerror = () => {
        finish(false, socket);
      };
      setTimeout(() => {
        finish(false, socket);
      }, 3_000);
    } catch {
      resolve(false);
    }
  });
}
