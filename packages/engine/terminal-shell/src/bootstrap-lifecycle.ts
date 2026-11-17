import { fireSessionStart } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { emitSessionStarted, emitSessionReady } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { NoticeLevel } from '@goodvibes-jev/engine/platform/platform/core';
import type { TerminalCommandRegistry } from './command-registry.js';
import { startMcpConfigAutoReload, type McpRuntimeReloadOptions } from './mcp-runtime-reload.js';

export function createPluginCommandAdapter<Context>(registry: Pick<TerminalCommandRegistry<Context>, 'register' | 'unregister'>) {
  return {
    register(command: {
      readonly name: string;
      readonly aliases?: readonly string[] | undefined;
      readonly description: string;
      readonly usage?: string | undefined;
      readonly argsHint?: string | undefined;
      readonly handler: (args: string[]) => void | Promise<void>;
    }): void {
      registry.register({ ...command, aliases: command.aliases ? [...command.aliases] : undefined });
    },
    unregister: (name: string): void => registry.unregister(name),
  };
}
export function wireTerminalMcpReload(
  roots: McpRuntimeReloadOptions['roots'],
  registry: McpRuntimeReloadOptions['registry'],
  discovery: { stop(): void | Promise<void> },
  unsubs: Array<() => void | Promise<void>>,
  router: { low(text: string): void; high(text: string, level?: NoticeLevel): void },
  render: () => void,
): void {
  const reload = startMcpConfigAutoReload({
    roots,
    registry,
    onReload: ({ connected, total }) => {
      router.low(`[MCP] Reloaded config: ${connected}/${total} server(s) connected.`);
      render();
    },
    onError: (error) => {
      const message = summarizeError(error);
      logger.warn('MCP config auto-reload failed', { error: message });
      router.high(`[MCP] Config reload failed: ${message}`, 'error');
      render();
    },
  });
  // The watcher stops before the servers are released, so a config edit during the disconnect cannot reconnect them.
  unsubs.push(() => reload.stop());
  unsubs.push(() => discovery.stop());
}
export function announceTerminalSessionStarted(
  sessionId: string,
  workingDir: string,
  hookDispatcher: Parameters<typeof fireSessionStart>[1],
  bus: Parameters<typeof emitSessionStarted>[0],
): void {
  fireSessionStart(sessionId, hookDispatcher);
  emitSessionStarted(
    bus,
    { sessionId, traceId: `${sessionId}:session-start`, source: 'bootstrap' },
    { sessionId, profileId: 'default', workingDir },
  );
  emitSessionReady(bus, { sessionId, traceId: `${sessionId}:session-ready`, source: 'bootstrap' }, { sessionId });
}

