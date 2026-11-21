import { yesNo, formatJsonOrText } from '@goodvibes/engine/terminal-shell/cli-output';
export { yesNo, formatJsonOrText } from '@goodvibes/engine/terminal-shell/cli-output';
import { stableUrlHostForBindHost } from '@goodvibes/engine/platform/platform/pairing';
import {
  splitCommandOption,
  readOptionValue,
  readOptionValues,
  hasCommandFlag,
  commandValues,
  isPresentConfigValue,
} from '@goodvibes/engine/terminal-shell/cli-arguments';
export {
  splitCommandOption,
  readOptionValue,
  readOptionValues,
  hasCommandFlag,
  commandValues,
  isPresentConfigValue,
} from '@goodvibes/engine/terminal-shell/cli-arguments';
import { runNativeHeadlessCommand } from './native-headless-command.ts';
import { createDaemonConfigClient } from '@goodvibes/engine/platform/platform/runtime/client';
import { createDaemonVerbCaller } from '../runtime/client/operator-endpoint.ts';
/**
 * management-utils.ts, shared CLI utility functions.
 *
 * Extracted from management.ts to break the import cycle:
 *   management.ts ↔ management-commands.ts
 *   management.ts ↔ surface-command.ts
 *
 * Both management-commands.ts and surface-command.ts import from here;
 * management.ts also imports from here (no longer from the child modules
 * for these utilities).
 *
 * No imports from management-commands.ts or surface-command.ts are allowed
 * in this file, that would recreate the cycle.
 */

import { readFileSync } from 'node:fs';
import net from 'node:net';
import type { ConfigManager, GoodVibesConfig } from '@goodvibes/engine/platform/platform/config';
import { REGULAR_KNOWLEDGE_DB_FILE, prepareConfiguredProjectContext } from '@goodvibes/engine/platform/platform/knowledge';
import { createRuntimeServices } from '../runtime/services.ts';
import { createRuntimeStore } from '@goodvibes/engine/platform/platform/runtime/state';
import type { RuntimeServices } from '../runtime/services.ts';
import type { ProviderCatalogOptions } from '@goodvibes/engine/platform/platform/providers';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { resolveRuntimeEndpointBinding } from '@goodvibes/engine/terminal-shell';
import { applyRuntimeEndpointFlagOverrides } from '@goodvibes/engine/terminal-shell';
import type { RuntimeEndpointId } from '@goodvibes/engine/terminal-shell';
import type { CliCommandRuntime } from '@goodvibes/engine/terminal-shell';

export function readPassword(args: readonly string[]): string | null {
  const explicit = readOptionValue(args, '--password');
  if (explicit !== undefined) return explicit;
  if (hasCommandFlag(args, '--password-stdin')) return readFileSync(0, 'utf-8').trimEnd();
  return process.env.GOODVIBES_AUTH_PASSWORD ?? null;
}

export function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function connectHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host || '127.0.0.1';
}

/**
 * Where another machine dials (a pairing QR code, a phone-facing link): the
 * engine's stable-host rule, the same one the daemon and the Agent print.
 */
export function urlHostForBindHost(host: string): string {
  return stableUrlHostForBindHost(host).host;
}

/**
 * Runs a one-shot command's settings writes the way the terminal makes them:
 * while the daemon is reachable a daemon-owned setting is sent to it (the one
 * writer of its file); with none reachable it is written to the daemon's file
 * for it to read when it starts. Returns what the command returned and the
 * settings the daemon refused, each already put back in this process's view.
 */
export async function withDaemonSettingsRoute<T>(
  runtime: CliCommandRuntime,
  run: () => T | Promise<T>,
): Promise<{ readonly result: T; readonly refused: readonly { readonly key: string; readonly error: unknown }[] }> {
  const config = runtime.configManager;
  const daemonConfig = createDaemonConfigClient(createDaemonVerbCaller({ configManager: config, homeDirectory: runtime.homeDirectory }));
  const detach = config.attachDaemonRoute({
    reachable: () => daemonConfig.reachable(),
    write: (key, value) => daemonConfig.set(key, value),
    writeMany: (changes) => daemonConfig.setMany(changes),
    ...(daemonConfig.reset ? { reset: (key: string) => daemonConfig.reset!(key) } : {}),
  });
  try {
    const result = await run();
    return { result, refused: await config.settleDaemonWrites() };
  } finally {
    detach();
  }
}

export function enableServicePosture(config: ConfigManager): void {
  config.setDynamic('service.enabled', true);
  config.setDynamic('service.autostart', true);
  config.setDynamic('service.restartOnFailure', true);
}

export function enableEndpointLanDefault(config: ConfigManager, endpoint: RuntimeEndpointId): void {
  const binding = resolveRuntimeEndpointBinding(config, endpoint);
  if (binding.hostMode === 'custom') return;
  if (endpoint === 'controlPlane') {
    config.setDynamic('controlPlane.hostMode', 'network');
    config.setDynamic('controlPlane.host', '0.0.0.0');
    return;
  }
  if (endpoint === 'httpListener') {
    config.setDynamic('httpListener.hostMode', 'network');
    config.setDynamic('httpListener.host', '0.0.0.0');
    return;
  }
  config.setDynamic('web.hostMode', 'network');
  config.setDynamic('web.host', '0.0.0.0');
}

export function applyTargetEndpointFlagsOrDefault(runtime: CliCommandRuntime, endpoint: RuntimeEndpointId): string | null {
  const errors = applyRuntimeEndpointFlagOverrides(runtime.configManager, endpoint, runtime.cli.flags);
  if (errors.length > 0) return errors.join('\n');
  if (runtime.cli.flags.hostname === undefined) {
    enableEndpointLanDefault(runtime.configManager, endpoint);
  }
  return null;
}

/**
 * Re-export openBrowser from utils/browser.ts for backward compatibility.
 * management.ts and management-commands.ts both used to export/import this;
 * now all callers should prefer importing from utils/browser.ts directly.
 */
export { openBrowser } from '../utils/browser.ts';

export async function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: connectHostForBindHost(host), port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function withRuntimeServices<T>(
  runtime: CliCommandRuntime,
  fn: (services: RuntimeServices) => Promise<T> | T,
  options: { readonly modelData?: 'background' | 'skip'; readonly catalog?: ProviderCatalogOptions } = {},
): Promise<T> {
  // This helper starts the complete active runtime, including its native work
  // services. Prepare its real project before any synchronous owner freezes an
  // identity; lightweight metadata probes do not use this full-graph helper.
  await prepareConfiguredProjectContext(runtime.configManager, runtime.workingDirectory, REGULAR_KNOWLEDGE_DB_FILE, { activate: true });
  // Point the bus listener cap at runtime.eventBus.maxListeners before the
  // first bus exists, so every bus this process builds later uses it.
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => runtime.configManager.get(key)));
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  const services = createRuntimeServices({
    // One-shot commands consume the stored catalog; a background refresh would
    // outlive this graph. Interactive startup retains its normal refresh.
    modelDiscovery: 'skip',
    configManager: runtime.configManager,
    runtimeBus,
    runtimeStore,
    workingDir: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  try {
    if (options.modelData !== 'skip') {
      services.providerRegistry.initModelLimits();
      services.benchmarkStore.initBenchmarks();
      services.providerRegistry.initCatalog(options.catalog);
    }
    await services.providerRegistry.ready();
    const result = await fn(services);
    // A daemon setting the command changed went to the daemon; wait for its
    // answer before this process exits, and say which ones it refused.
    for (const refused of await runtime.configManager.settleDaemonWrites()) {
      process.stderr.write(`The daemon refused ${refused.key}; it was not changed: ${summarizeError(refused.error)}\n`);
    }
    return result;
  } finally {
    services.providerRegistry.stopWatching();
    // A one-shot command still composes the whole graph, and that graph starts
    // pollers. Disposing lets the command finish instead of relying on process
    // exit to reclaim them.
    await services.close();
  }
}

export { readAuthPaths } from './auth-paths.ts';

export async function runNonInteractiveAgent(runtime: CliCommandRuntime): Promise<number> {
  return runNativeHeadlessCommand(runtime);
}

/** @deprecated Use ConfigManager directly. Kept for backward compat with management.ts usages. */
export type { GoodVibesConfig };
