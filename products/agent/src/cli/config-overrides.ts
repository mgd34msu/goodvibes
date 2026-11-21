import type { ConfigKey, ConfigManager } from '../config/index.ts';
import { ConfigError } from '@goodvibes/engine/platform/platform/types/errors';
import { DEFAULT_CONTROL_PLANE_PORT, parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { resolveFeatureEnablementWrite } from '../runtime/feature-enablement.ts';
import type { GoodVibesCliCommand, GoodVibesCliFlags } from './types.ts';
import { RUNTIME_ENDPOINT_CONFIG_KEYS, hostModeForHostname } from './endpoints.ts';
import type { RuntimeEndpointId } from './endpoints.ts';

function parseConfigOverrideValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
}

function parseRuntimeUrl(rawValue: string, source: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`${source} requires a non-empty http(s)://host:port value.`);
  }

  const value = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${source} must be a valid http(s)://host:port URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${source} must use http:// or https://.`);
  }
  if (!url.hostname) {
    throw new ConfigError(`${source} must include a hostname.`);
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`${source} must point at the connected GoodVibes API root, not a path, query, hash or user name.`);
  }

  // Without a port, the daemon's default port: a bare host names a GoodVibes daemon, not a web server.
  // The URL parser drops a port equal to the scheme's default, so a written port is read from the text.
  const writtenPort = /^[a-z][a-z\d+.-]*:\/\/(?:\[[^\]]*\]|[^/:?#]*):(\d+)/i.exec(value)?.[1];
  const port = writtenPort ? Number.parseInt(writtenPort, 10) : DEFAULT_CONTROL_PLANE_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${source} port must be from 1 to 65535.`);
  }
  const origin = parseDaemonOrigin(`${url.protocol}//${url.host.replace(/:\d+$/, '')}:${port}`);
  if (!origin) throw new ConfigError(`${source} must be a valid http(s)://host:port URL.`);
  return origin.baseUrl;
}

export function applyRuntimeConfigValue(configManager: ConfigManager, key: ConfigKey, value: unknown): void {
  configManager.setRuntimeOverride(key, value as never);
}

export function applyRuntimeConfigOverrides(
  configManager: ConfigManager,
  overrides: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  for (const override of overrides) {
    const index = override.indexOf('=');
    if (index <= 0) {
      errors.push('Invalid --config override. Expected key=value.');
      continue;
    }
    const key = override.slice(0, index) as ConfigKey;
    const rawValue = override.slice(index + 1);
    try {
      applyRuntimeConfigValue(configManager, key, parseConfigOverrideValue(rawValue));
    } catch (error) {
      errors.push(error instanceof Error ? `Invalid --config override. ${error.message}` : 'Invalid --config override.');
    }
  }
  return errors;
}

export function applyRuntimeUrlOverride(
  configManager: ConfigManager,
  rawValue: string,
  source = '--runtime-url',
): readonly string[] {
  try {
    // The stated origin, scheme included, is the connected host for this run (connected-host-dial.ts reads it first).
    applyRuntimeConfigValue(configManager, 'daemon.connectedHost.url', parseRuntimeUrl(rawValue, source));
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : `Invalid ${source}`];
  }
}

/**
 * Apply --enable/--disable as RUNTIME-ONLY writes to the
 * feature's domain settings key (the dissolved feature model has no separate
 * enablement namespace). Nothing is persisted: the write lands on the
 * in-memory config just like --config overrides, and the settings-derived
 * gate seeding in bootstrap picks it up. Returns honest per-feature errors
 * (unknown ids, always-available features) instead of silently accepting
 * anything, matching applyRuntimeConfigOverrides' contract.
 */
export function applyRuntimeFeatureOverrides(
  configManager: ConfigManager,
  options: {
    readonly enableFeatures: readonly string[];
    readonly disableFeatures: readonly string[];
  },
): readonly string[] {
  const errors: string[] = [];
  const requests = [
    ...options.enableFeatures.map((featureId) => ({ featureId, desired: 'enabled' as const, flag: '--enable' })),
    ...options.disableFeatures.map((featureId) => ({ featureId, desired: 'disabled' as const, flag: '--disable' })),
  ];
  for (const request of requests) {
    try {
      const write = resolveFeatureEnablementWrite(request.featureId, request.desired);
      applyRuntimeConfigValue(configManager, write.key, write.value);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid ${request.flag} ${request.featureId}. ${error.message}`
        : `Invalid ${request.flag} ${request.featureId}`);
    }
  }
  return errors;
}

export function applyRuntimeEndpointFlagOverrides(
  configManager: ConfigManager,
  endpoint: RuntimeEndpointId,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  const keys = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const errors: string[] = [];

  if (flags.hostname !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.hostMode, hostModeForHostname(flags.hostname));
      applyRuntimeConfigValue(configManager, keys.host, flags.hostname);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --hostname. ${error.message}`
        : 'Invalid --hostname.');
    }
  }

  if (flags.port !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.port, flags.port);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --port. ${error.message}`
        : 'Invalid --port.');
    }
  }

  return errors;
}

export function applyRuntimeCommandEndpointFlagOverrides(
  configManager: ConfigManager,
  command: GoodVibesCliCommand,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  if (flags.hostname === undefined && flags.port === undefined) return [];
  if (command === 'pair') return applyRuntimeEndpointFlagOverrides(configManager, 'controlPlane', flags);
  return [];
}
