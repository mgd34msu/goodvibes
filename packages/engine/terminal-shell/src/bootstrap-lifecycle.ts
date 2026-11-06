import { CacheRegistry, PauseController } from '@goodvibes-jev/engine/sdk/platform/runtime/memory';
import { fireSessionStart } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { emitSessionStarted, emitSessionReady } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { TerminalCommandRegistry } from './command-registry.js';
import { startMcpConfigAutoReload, type McpRuntimeReloadOptions } from './mcp-runtime-reload.js';

export function createTerminalMemoryAdmission() {
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = {
    current: null,
  };
  return {
    cacheRegistry,
    pauseController,
    MEMORY_BACKGROUND_JOB_IDS,
    admitExpensiveWorkRef,
    admitExpensiveWork: (label: string): { allowed: boolean; reason?: string | undefined } =>
      admitExpensiveWorkRef.current?.(label) ?? { allowed: true },
    isKnowledgeBackgroundPaused: (): boolean => pauseController.isPaused('knowledge-self-improvement'),
  };
}
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
  discovery: { stop(): void },
  unsubs: Array<() => void | Promise<void>>,
  router: { low(text: string): void; high(text: string): void },
  render: () => void,
): void {
  unsubs.push(() => discovery.stop());
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
      router.high(`[MCP] Config reload failed: ${message}`);
      render();
    },
  });
  unsubs.push(() => reload.stop());
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
