import { resolveHostBinding, resolveWebPort } from '@goodvibes/engine/platform/platform/daemon/host-resolver';

export type RuntimeEndpointId = 'controlPlane' | 'httpListener' | 'web';
export type RuntimeHostMode = 'local' | 'network' | 'custom';
export type RuntimeEndpointSettingKey = `${RuntimeEndpointId}.${'hostMode' | 'host' | 'port'}`;

export interface RuntimeEndpointConfigReader {
  get(key: RuntimeEndpointSettingKey): unknown;
}

export const RUNTIME_ENDPOINT_DEFAULT_PORTS: Record<RuntimeEndpointId, number> = {
  controlPlane: 3421,
  httpListener: 3422,
  web: 3423,
};

export const RUNTIME_ENDPOINT_CONFIG_KEYS: {
  [Endpoint in RuntimeEndpointId]: {
    readonly hostMode: `${Endpoint}.hostMode`;
    readonly host: `${Endpoint}.host`;
    readonly port: `${Endpoint}.port`;
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
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
}

export function hostModeForHostname(hostname: string): RuntimeHostMode {
  const normalized = hostname.toLowerCase();
  if (normalized === '0.0.0.0' || normalized === '::') return 'network';
  if (normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1') return 'local';
  return 'custom';
}

export function resolveRuntimeEndpointBinding(
  config: RuntimeEndpointConfigReader,
  endpoint: RuntimeEndpointId,
): RuntimeEndpointBinding {
  const keys = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const hostMode = String(config.get(keys.hostMode) ?? 'local');
  const configuredHost = String(config.get(keys.host) ?? '127.0.0.1');
  const rawPort = config.get(keys.port);
  // The platform's bind rule decides host, port and mode; an unrecognized mode
  // is read as local, and is shown as stored.
  const binding = resolveHostBinding(hostMode, configuredHost, Number(rawPort ?? RUNTIME_ENDPOINT_DEFAULT_PORTS[endpoint]), endpoint);
  return {
    hostMode: binding.recognized ? binding.effectiveMode : hostMode,
    configuredHost,
    host: binding.host,
    port: endpoint === 'web' ? resolveWebPort(rawPort) : binding.port,
  };
}
