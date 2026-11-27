import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import type { NoticeLevel } from '../core/conversation.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { scan, scanLocalhost, loadPersistedProviders, persistProviders, scanMcpServers } from '../discovery/index.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { ShellPathService } from './shell-paths.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { summarizeError } from '../utils/error-display.js';
import { isLoopbackHost } from '../utils/reachable-base-url.js';
import { splitModelRegistryKey } from '../providers/registry-helpers.js';

export interface RuntimeSelectionState {
  model: string;
  provider: string;
}

export interface HostSystemMessageSink {
  low(message: string): void;
  high(message: string, level?: NoticeLevel): void;
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
   * Sweep the private networks this computer is attached to and register the servers found on other
   * machines as providers. Off by default: only this computer is probed, since any host that answers on
   * a well-known port would otherwise become a provider that prompts can be sent to. Turn it on only
   * after the person asked for the network scan. Servers on this computer are always registered.
   */
  registerNetworkServers?: boolean | undefined;
  /** The scan; replaceable so a host or a test supplies its own. */
  scan?: typeof scan | undefined;
  /**
   * The outcome as data, for a host that words it itself. When present, the
   * per-server lines are not written to `systemMessageRouter`; a warning that the
   * active model's server did not answer is still written there.
   */
  report?: ProviderDiscoveryReporter | undefined;
}

/** One model server, as a discovery report names it. */
export interface DiscoveredServerSummary {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly models: number;
}

export interface ProviderDiscoveryReporter {
  /** Servers saved by an earlier session: registered ones, and network ones left unregistered. */
  restored?(report: { readonly registered: readonly DiscoveredServerSummary[]; readonly unregisteredNetwork: readonly DiscoveredServerSummary[] }): void;
  /** One scan: servers registered for the first time, saved ones that did not answer and were kept, network ones left unregistered. */
  scanned?(report: {
    readonly found: readonly DiscoveredServerSummary[];
    readonly kept: readonly DiscoveredServerSummary[];
    readonly unregisteredNetwork: readonly DiscoveredServerSummary[];
    /** Servers that answered but could not be identified or read, so they were left out. */
    readonly skipped: readonly { readonly host: string; readonly port: number; readonly reason: string }[];
  }): void;
}

export interface BackgroundRuntimeTaskHandle {
  readonly stopped: boolean;
  /** A handle that owns external resources returns the promise of their release; await it at shutdown. */
  stop(): void | Promise<void>;
}

const serverKey = (server: { readonly host: string; readonly port: number }): string => `${server.host}:${server.port}`;
const describeModels = (server: { readonly models: readonly unknown[] }): string =>
  `${server.models.length} model${server.models.length !== 1 ? 's' : ''}`;
const summarize = (server: { readonly name: string; readonly host: string; readonly port: number; readonly models: readonly unknown[] }): DiscoveredServerSummary =>
  ({ name: server.name, host: server.host, port: server.port, models: server.models.length });

/**
 * Starts one asynchronous provider discovery pass and returns a handle whose
 * `stop()` cancels the scan's requests and keeps late results from changing
 * runtime state after the host stops.
 */
export function startBackgroundProviderDiscovery(
  options: BackgroundProviderDiscoveryOptions,
): BackgroundRuntimeTaskHandle {
  const { configManager, providerRegistry, runtime, requestRender, restoreRuntimeModel, systemMessageRouter, shellPaths, surfaceRoot, report } = options;
  const runScan: typeof scan = options.scan
    ?? (options.registerNetworkServers === true ? scan : (_onProgress, signal) => scanLocalhost(signal));
  const trusted = (server: { readonly host: string }): boolean => options.registerNetworkServers === true || isLoopbackHost(server.host);
  let stopped = false;
  const lifetime = new AbortController();
  const handle: BackgroundRuntimeTaskHandle = {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      lifetime.abort();
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
      if (report) {
        report.restored?.({ registered: registrable.map(summarize), unregisteredNetwork: persisted.filter((server) => !trusted(server)).map(summarize) });
      } else {
        for (const server of persisted) {
          systemMessageRouter.low(trusted(server)
            ? `[Local] ${server.name} at ${server.host}:${server.port} (${describeModels(server)}), from last session`
            : `[Local] ${server.name} at ${server.host}:${server.port} is on the network, not on this computer, so it was not registered`);
        }
      }
      requestRender();
    } catch (err) {
      logger.warn('[bootstrap] Persisted provider registration failed', {
        error: summarizeError(err),
      });
    }
  }

  runScan(undefined, lifetime.signal).then((result) => {
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

    // A missed server is reported only when the scan reached something, as below.
    const kept = local.length > 0 ? missedServers : [];
    if (report) {
      report.scanned?.({ found: newServers.map(summarize), kept: kept.map(summarize), unregisteredNetwork: network.map(summarize), skipped: result.skipped });
    } else {
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
      for (const server of result.skipped) {
        systemMessageRouter.low(`[Scan] ${server.host}:${server.port} answered but was left out: ${server.reason}`);
      }
    }

    // One scan that misses a server is not proof it is gone (it may still be starting), so nothing is
    // removed, switched or rewritten here; the cache drops a server that stays unseen for its age limit.
    if (kept.length > 0) {
      let currentModelBareId: string | undefined;
      try { currentModelBareId = splitModelRegistryKey(configManager.get('provider.model') as string).resolvedModelId; } catch { /* An unqualified saved model names no server. */ }
      for (const server of kept) {
        if (!report) systemMessageRouter.low(`[Scan] ${server.name} at ${server.host}:${server.port} did not answer this scan; it is kept`);
        if (currentModelBareId !== undefined && server.models.includes(currentModelBareId)) {
          systemMessageRouter.high(
            `[Scan] The active model is on ${server.name}, which did not answer this scan. Nothing was switched and your saved model is unchanged; pick another model if requests fail.`,
            'warning',
          );
        }
      }
    }

    if (local.length > 0) {
      persistProviders({ ...shellPaths, surfaceRoot }, local);
    }

    if (newServers.length > 0 || kept.length > 0 || network.length > 0) {
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
  /** False: the servers are not started here (a headless run starts them on its turn's first `mcp` call). Default true. */
  connectOnStart?: boolean | undefined;
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

  // The servers' files are the project's (its root's `.goodvibes/mcp.json`), wherever in it the program was started.
  const projectRoots = { workingDirectory: projectIdentityOf(shellPaths.workingDirectory), homeDirectory: shellPaths.homeDirectory };
  if (options.connectOnStart !== false) {
    mcpRegistry.connectAll(projectRoots).catch((err) => {
      if (stopped) return;
      logger.warn('MCP auto-connect failed', { error: summarizeError(err) });
    });
  }

  scanTimer = setTimeout(() => {
    scanTimer = null;
    if (stopped) return;
    const registeredNames = new Set(mcpRegistry.serverNames);
    scanMcpServers({ ...projectRoots, surfaceRoot }, registeredNames).then((result) => {
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
