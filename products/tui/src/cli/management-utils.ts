import { commandTextExitCode } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { yesNo, formatJsonOrText } from '@goodvibes-jev/engine/terminal-shell/cli-output';
export { yesNo, formatJsonOrText } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { getLocalNetworkIp } from '@goodvibes-jev/engine/terminal-shell/cli-environment';
import {
  splitCommandOption,
  readOptionValue,
  readOptionValues,
  hasCommandFlag,
  commandValues,
  isPresentConfigValue,
  extractAuthorizationCode,
} from '@goodvibes-jev/engine/terminal-shell/cli-arguments';
export {
  splitCommandOption,
  readOptionValue,
  readOptionValues,
  hasCommandFlag,
  commandValues,
  isPresentConfigValue,
  extractAuthorizationCode,
} from '@goodvibes-jev/engine/terminal-shell/cli-arguments';
import { runNativeHeadlessCommand } from './native-headless-command.ts';
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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import 'node:child_process';
import 'node:os';
import type { ConfigManager, GoodVibesConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createRuntimeServices } from '../runtime/services.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import type { ProviderCatalogOptions } from '@goodvibes-jev/engine/sdk/platform/providers';
import { RuntimeEventBus, createShellPathService, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '@/runtime/index.ts';
import '@goodvibes-jev/engine/sdk/platform/utils';
import { resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { applyRuntimeEndpointFlagOverrides } from '@goodvibes-jev/engine/terminal-shell';
import type { RuntimeEndpointId } from '@goodvibes-jev/engine/terminal-shell';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import '../utils/browser.ts';

export function exitCodeForText(output: string): number {
  return commandTextExitCode(output, ['Usage:', 'Invalid '], ['Session not found:', 'Unknown task:', 'Task submit failed ']);
}

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

export function urlHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return getLocalNetworkIp();
  return host || '127.0.0.1';
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
    config.setDynamic('controlPlane.allowRemote', true);
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
  if (endpoint === 'controlPlane') {
    const binding = resolveRuntimeEndpointBinding(runtime.configManager, endpoint);
    runtime.configManager.setDynamic('controlPlane.allowRemote', binding.hostMode !== 'local');
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
  options: { readonly catalog?: ProviderCatalogOptions } = {},
): Promise<T> {
  // This helper starts the complete active runtime, including its native work
  // services. Prepare its real project before any synchronous owner freezes an
  // identity; lightweight metadata probes do not use this full-graph helper.
  await prepareConfiguredProjectContext(runtime.configManager, runtime.workingDirectory, 'knowledge-wiki.sqlite', { activate: true });
  // Point the bus listener cap at runtime.eventBus.maxListeners before the
  // first bus exists, so every bus this process builds later uses it.
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => runtime.configManager.get(key)));
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  const services = createRuntimeServices({
    configManager: runtime.configManager,
    runtimeBus,
    runtimeStore,
    workingDir: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  services.providerRegistry.initModelLimits();
  services.benchmarkStore.initBenchmarks();
  services.providerRegistry.initCatalog(options.catalog);
  try {
    await services.providerRegistry.ready();
    return await fn(services);
  } finally {
    services.providerRegistry.stopWatching();
    // A one-shot command still composes the whole graph, and that graph starts
    // pollers. Disposing lets the command finish instead of relying on process
    // exit to reclaim them.
    await services.close();
  }
}

export function readAuthPaths(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath('tui', 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt');
  const operatorTokenPath = join(runtime.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath,
    operatorTokenPresent: existsSync(operatorTokenPath),
  };
}

export async function runNonInteractiveAgent(runtime: CliCommandRuntime): Promise<number> {
  return runNativeHeadlessCommand(runtime);
}

/** @deprecated Use ConfigManager directly. Kept for backward compat with management.ts usages. */
export type { GoodVibesConfig };
