/**
 * mcp-lazy-start.ts, MCP servers start when a tool needs one, not at boot.
 *
 * ── What was happening ─────────────────────────────────────────────────────
 *
 * `scheduleBackgroundMcpDiscovery()` calls `mcpRegistry.connectAll()` as its
 * first act, and the agent called it during bootstrap. So every server in
 * `mcp.json` was spawned by simply LAUNCHING the agent, before any prompt,
 * any tool call, or any decision by the person sitting there.
 *
 * On a real machine that meant a bare `goodvibes-agent` boot spawned:
 *
 *   npm exec @playwright/mcp@latest --extension --output-dir /tmp/…
 *   npm exec zen-devtools-mcp@latest --zen-path … --start-url https://console.cloud.google.com/
 *
 * Two browser-automation servers, one of them pointed at a cloud console with
 * a dedicated profile. Nobody asked for browser automation at startup. It is
 * startup cost, it is `npm exec` fetching and running packages on every boot,
 * and a configured start-url is a browser window that can appear on someone's
 * screen because they opened a terminal.
 *
 * ── What this does ─────────────────────────────────────────────────────────
 *
 * The registry is wrapped so a server connects on FIRST USE and never at
 * boot, and only the server a use addresses: calling a tool or reading its
 * schema connects that one server, so a slow or dead server never delays a
 * call to a healthy one. Listing tools starts every configured server in the
 * background and returns the tools of those already connected; the others
 * report `starting` in the server list until they are ready. Everything else
 * passes straight through and starts nothing.
 *
 * `serverNames` deliberately does NOT trigger a connect: it is what callers ask
 * when they want to know what is CONFIGURED, and making that question spawn
 * processes would rebuild the problem through the back door.
 *
 * A server that failed to start is not remembered as failed: the next call
 * addressed to it tries again, and the call that failed is refused with the
 * reason, so the model can say "server X failed to start: why" instead of
 * "no such tool".
 *
 * The suggestion scan ("discovered server X, add it to mcp.json",
 * mcp-suggestion-scan.ts) reads only configured names and the filesystem, so
 * it starts nothing either.
 */

import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** The config roots `connectAll` reads `mcp.json` from. */
export type McpConfigRoots = Parameters<McpRegistry['connectAll']>[0];

export interface LazyMcpStart {
  /**
   * The registry every consumer should be handed. Identical to the real one
   * except that it starts servers on demand.
   */
  readonly registry: McpRegistry;
}

/** The server a qualified tool name (`mcp:<server>:<tool>`) addresses. */
function serverOf(qualifiedName: unknown): string | undefined {
  if (typeof qualifiedName !== 'string') return undefined;
  const parts = qualifiedName.split(':');
  return parts.length >= 3 && parts[0] === 'mcp' && parts[1] ? parts[1] : undefined;
}

export function createLazyMcpRegistry(
  registry: McpRegistry,
  roots: McpConfigRoots,
): LazyMcpStart {
  const connecting = new Map<string, Promise<void>>();

  /** Connect only the addressed server; a name that is not configured is left for the call to report. */
  const ensureServer = async (serverName: string): Promise<void> => {
    let pending = connecting.get(serverName);
    if (!pending) {
      pending = registry.connectConfigured(roots, serverName)
        .catch((error: unknown) => {
          logger.warn('MCP connect-on-use failed', { server: serverName, error: summarizeError(error) });
          // Refused with the real reason: running the call against a server that
          // never connected would tell the model the tool does not exist.
          throw new Error(`MCP server '${serverName}' failed to start: ${summarizeError(error)}. The call was not made; the next call to this server tries to start it again.`);
        })
        .finally(() => connecting.delete(serverName));
      connecting.set(serverName, pending);
    }
    await pending;
  };

  let startedAll = false;
  /**
   * Start, in the background, every configured server that is neither connected
   * nor starting, on the first listing only: later listings read no file, and a
   * server that failed is retried by the next call addressed to it (or a reload).
   */
  const startUnready = (target: McpRegistry): void => {
    if (startedAll) return;
    startedAll = true;
    target.startConfigured(roots);
  };

  const proxied = new Proxy(registry, {
    get(target, property): unknown {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const call = value as (...args: unknown[]) => unknown;
      if (property === 'callTool' || property === 'getToolSchema') {
        return async (...args: unknown[]): Promise<unknown> => {
          const serverName = serverOf(args[0]);
          if (serverName) await ensureServer(serverName);
          return call.apply(target, args);
        };
      }
      if (property === 'listAllTools') {
        return async (...args: unknown[]): Promise<unknown> => {
          // Ready servers answer now; the rest start in the background and list as `starting`.
          startUnready(target);
          return call.apply(target, args);
        };
      }
      if (property === 'captureToolCatalog') {
        // Started before the capture, so the read is taken against the servers it set going.
        return (...args: unknown[]): unknown => { startUnready(target); return call.apply(target, args); };
      }
      return call.bind(target);
    },
    set(target, property, value): boolean {
      return Reflect.set(target, property, value, target);
    },
  });

  return { registry: proxied };
}
