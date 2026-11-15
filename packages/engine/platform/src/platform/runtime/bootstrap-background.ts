import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { autoRegisterProviders } from '../providers/auto-register.js';
import { scan, loadPersistedProviders, persistProviders, scanMcpServers } from '../discovery/index.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { ShellPathService } from './shell-paths.js';
import { summarizeError } from '../utils/error-display.js';
import { splitModelRegistryKey } from '../providers/registry-helpers.js';

export interface RuntimeSelectionState {
  model: string;
  provider: string;
}

export interface HostSystemMessageSink {
  low(message: string): void;
  high(message: string): void;
}

export interface BackgroundProviderDiscoveryOptions {
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  runtime: RuntimeSelectionState;
  requestRender: () => void;
  restoreRuntimeModel: (providerRegistry: ProviderRegistry, savedModel: string, runtime: RuntimeSelectionState) => void;
  systemMessageRouter: HostSystemMessageSink;
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  surfaceRoot: string;
  /**
   * Register servers found on other machines of the network as providers. Off by default: any host that
   * answers on a well-known port would otherwise become a provider that prompts can be sent to.
   * Servers on this computer are always registered.
   */
  registerNetworkServers?: boolean | undefined;
  /** The network scan; replaceable so a host or a test supplies its own. */
  scan?: typeof scan | undefined;
}

export interface BackgroundRuntimeTaskHandle {
  readonly stopped: boolean;
  /** A handle that owns external resources returns the promise of their release; await it at shutdown. */
  stop(): void | Promise<void>;
}

/** Whether a discovered server runs on this computer. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(\.\d{1,3}){3}$/.test(normalized);
}

const serverKey = (server: { readonly host: string; readonly port: number }): string => `${server.host}:${server.port}`;
const describeModels = (server: { readonly models: readonly unknown[] }): string =>
  `${server.models.length} model${server.models.length !== 1 ? 's' : ''}`;

/**
 * Starts one asynchronous provider discovery pass and returns a handle that
 * prevents late scan results from mutating runtime state after the host stops.
 *
 * The underlying scanner does not currently expose cancellable I/O, so `stop()`
 * is intentionally a state guard rather than a hard abort.
 */
export function startBackgroundProviderDiscovery(
  options: BackgroundProviderDiscoveryOptions,
): BackgroundRuntimeTaskHandle {
  const { configManager, providerRegistry, runtime, requestRender, restoreRuntimeModel, systemMessageRouter, shellPaths, surfaceRoot } = options;
  const runScan = options.scan ?? scan;
  const trusted = (server: { readonly host: string }): boolean => options.registerNetworkServers === true || isLoopbackHost(server.host);
  autoRegisterProviders(providerRegistry);
  let stopped = false;
  const handle: BackgroundRuntimeTaskHandle = {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
    },
  };

  const persisted = loadPersistedProviders({ ...shellPaths, surfaceRoot });
  const registrable = persisted.filter(trusted);
  if (persisted.length > 0) {
    try {
      if (registrable.length > 0) {
        providerRegistry.registerDiscoveredProviders(registrable);
        restoreRuntimeModel(
          providerRegistry,
          configManager.get('provider.model') as string,
          runtime,
        );
      }
      for (const server of persisted) {
        systemMessageRouter.low(trusted(server)
          ? `[Local] ${server.name} at ${server.host}:${server.port} (${describeModels(server)}), from last session`
          : `[Local] ${server.name} at ${server.host}:${server.port} is on the network, not on this computer, so it was not registered`);
      }
      requestRender();
    } catch (err) {
      logger.warn('[bootstrap] Persisted provider registration failed', {
        error: summarizeError(err),
      });
    }
  }

  runScan().then((result) => {
    if (stopped) return;
    const local = result.servers.filter(trusted);
    const network = result.servers.filter((server) => !trusted(server));
    const foundKeys = new Set(result.servers.map(serverKey));
    const persistedKeys = new Set(persisted.map(serverKey));
    const newServers = local.filter((server) => !persistedKeys.has(serverKey(server)));
    const missedServers = registrable.filter((server) => !foundKeys.has(serverKey(server)));

    if (local.length > 0) {
      try {
        providerRegistry.registerDiscoveredProviders(local);
        restoreRuntimeModel(
          providerRegistry,
          configManager.get('provider.model') as string,
          runtime,
        );
      } catch (err) {
        logger.warn('[bootstrap] Scan provider registration failed', {
          error: summarizeError(err),
        });
      }
    }

    for (const server of newServers) {
      systemMessageRouter.low(
        `[Scan] Found ${server.name} at ${server.host}:${server.port} (${describeModels(server)})`,
      );
    }
    // A network host is never registered or remembered on its own say-so.
    for (const server of network) {
      systemMessageRouter.low(
        `[Scan] Found ${server.name} at ${server.host}:${server.port} (${describeModels(server)}) on the network; it was not registered. Register it only if you trust that machine.`,
      );
    }

    // One scan that misses a server is not proof it is gone (it may still be starting), so nothing is
    // removed, switched or rewritten here; the cache drops a server that stays unseen for its age limit.
    if (local.length > 0 && missedServers.length > 0) {
      let currentModelBareId: string | undefined;
      try { currentModelBareId = splitModelRegistryKey(configManager.get('provider.model') as string).resolvedModelId; } catch { /* An unqualified saved model names no server. */ }
      for (const server of missedServers) {
        systemMessageRouter.low(`[Scan] ${server.name} at ${server.host}:${server.port} did not answer this scan; it is kept`);
        if (currentModelBareId !== undefined && server.models.includes(currentModelBareId)) {
          systemMessageRouter.high(
            `[Scan] The active model is on ${server.name}, which did not answer this scan. Nothing was switched and your saved model is unchanged; pick another model if requests fail.`,
          );
        }
      }
    }

    if (local.length > 0) {
      persistProviders({ ...shellPaths, surfaceRoot }, local);
    }

    if (newServers.length > 0 || missedServers.length > 0 || network.length > 0) {
      requestRender();
    }
  }).catch((error: unknown) => {
    if (stopped) return;
    logger.warn('[bootstrap] Provider discovery scan failed', {
      error: summarizeError(error),
    });
  });
  return handle;
}

export interface BackgroundMcpDiscoveryOptions {
  mcpRegistry: McpRegistry;
  systemMessageRouter: HostSystemMessageSink;
  requestRender: () => void;
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  surfaceRoot: string;
}

/**
 * Schedules MCP auto-discovery and returns a handle that cancels the delayed
 * scan and suppresses late async side effects after host shutdown.
 */
export function scheduleBackgroundMcpDiscovery(options: BackgroundMcpDiscoveryOptions): BackgroundRuntimeTaskHandle {
  const { mcpRegistry, systemMessageRouter, requestRender, shellPaths, surfaceRoot } = options;
  let stopped = false;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  const handle: BackgroundRuntimeTaskHandle = {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      // The connect started below keeps running after the flag flips, and a terminal surface has no other
      // owner of the registry's stdio children and HTTP sessions.
      return mcpRegistry.disconnectAll().catch((err: unknown) => {
        logger.warn('MCP disconnect at shutdown failed', { error: summarizeError(err) });
      });
    },
  };

  mcpRegistry.connectAll(shellPaths).catch((err) => {
    if (stopped) return;
    logger.warn('MCP auto-connect failed', { error: summarizeError(err) });
  });

  scanTimer = setTimeout(() => {
    scanTimer = null;
    if (stopped) return;
    const registeredNames = new Set(mcpRegistry.serverNames);
    scanMcpServers({ ...shellPaths, surfaceRoot }, registeredNames).then((result) => {
      if (stopped) return;
      if (result.suggestions.length === 0) return;
      for (const suggestion of result.suggestions) {
        systemMessageRouter.low(
          `[MCP] Discovered server '${suggestion.name}' (${suggestion.command} ${(suggestion.args ?? []).join(' ')}). Add it to .goodvibes/mcp.json or ~/.config/mcp/mcp.json to enable it.`,
        );
      }
      requestRender();
    }).catch((err) => {
      if (stopped) return;
      logger.warn('MCP auto-discovery scan failed', { error: summarizeError(err) });
    });
  }, 2000);
  scanTimer.unref?.();
  return handle;
}
