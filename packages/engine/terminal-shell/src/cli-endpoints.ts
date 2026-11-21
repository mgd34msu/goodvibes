/**
 * cli-endpoints.ts, the shared config keys, defaults, and display resolution
 * for the three network endpoints a front-end's daemon exposes: the control
 * plane, the plain HTTP listener, and the web UI.
 */
import { resolveHostBinding, resolveWebPort } from '@goodvibes/engine/platform/platform/daemon/host-resolver';
import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';

export type RuntimeEndpointId = 'controlPlane' | 'httpListener' | 'web';
export type RuntimeHostMode = 'local' | 'network' | 'custom';
export type RuntimeEndpointSettingKey<E extends RuntimeEndpointId = RuntimeEndpointId> = `${E}.${'hostMode' | 'host' | 'port'}`;

/**
 * Any reader of the endpoint settings: a config manager or a narrower view of
 * one. A reader of some endpoints only (`RuntimeEndpointConfigReader<'controlPlane'>`)
 * serves those endpoints.
 */
export interface RuntimeEndpointConfigReader<E extends RuntimeEndpointId = RuntimeEndpointId> {
  get(key: RuntimeEndpointSettingKey<E>): unknown;
}

export const RUNTIME_ENDPOINT_DEFAULT_PORTS: Record<RuntimeEndpointId, number> = {
  controlPlane: 3421,
  httpListener: 3422,
  web: 3423,
};

export const RUNTIME_ENDPOINT_CONFIG_KEYS: {
  readonly [E in RuntimeEndpointId]: {
    readonly hostMode: `${E}.hostMode` & ConfigKey;
    readonly host: `${E}.host` & ConfigKey;
    readonly port: `${E}.port` & ConfigKey;
  };
} = {
  controlPlane: {
    hostMode: 'controlPlane.hostMode',
    host: 'controlPlane.host',
    port: 'controlPlane.port',
  },
  httpListener: {
    hostMode: 'httpListener.hostMode',
    host: 'httpListener.host',
    port: 'httpListener.port',
  },
  web: {
    hostMode: 'web.hostMode',
    host: 'web.host',
    port: 'web.port',
  },
};

export interface RuntimeEndpointBinding {
  /** The applied mode when recognized; the stored text as written when not. */
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
  /**
   * False when the stored hostMode is not one of 'local' | 'network' | 'custom'
   * (after trimming and lowercasing). The platform's bind rule then applies
   * the local posture, so host and port are 127.0.0.1 and the endpoint's port.
   */
  readonly recognized: boolean;
}

/**
 * The one text form of an endpoint binding: `<mode> <host>:<port>`, or, for an
 * unrecognized stored mode, that mode named with the local binding the
 * platform applies in its place.
 */
export function formatRuntimeEndpointBinding(binding: RuntimeEndpointBinding): string {
  if (binding.recognized) {
    return `${binding.hostMode} ${binding.host}:${binding.port}`;
  }
  return `'${binding.hostMode}', not a recognized host mode (expected local|network|custom); read as local, this computer only (${binding.host}:${binding.port})`;
}

export function hostModeForHostname(hostname: string): RuntimeHostMode {
  const normalized = hostname.toLowerCase();
  if (normalized === '0.0.0.0' || normalized === '::') return 'network';
  if (normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1') return 'local';
  return 'custom';
}

export function resolveRuntimeEndpointBinding<E extends RuntimeEndpointId>(
  config: RuntimeEndpointConfigReader<E>,
  endpoint: E,
): RuntimeEndpointBinding {
  const keys: { readonly hostMode: RuntimeEndpointSettingKey<E>; readonly host: RuntimeEndpointSettingKey<E>; readonly port: RuntimeEndpointSettingKey<E> } = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const hostMode = String(config.get(keys.hostMode) ?? 'local');
  const configuredHost = String(config.get(keys.host) ?? '127.0.0.1');
  const rawPort = config.get(keys.port);
  // The platform's bind rule decides host, port and mode; the web port goes
  // through the platform's own web port rule, which every web surface uses.
  const binding = resolveHostBinding(hostMode, configuredHost, Number(rawPort ?? RUNTIME_ENDPOINT_DEFAULT_PORTS[endpoint]), endpoint);
  return {
    hostMode: binding.recognized ? binding.effectiveMode : hostMode,
    configuredHost,
    host: binding.host,
    port: endpoint === 'web' ? resolveWebPort(rawPort) : binding.port,
    recognized: binding.recognized,
  };
}
