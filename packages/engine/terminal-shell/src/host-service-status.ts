import type { HostServiceStatus, HostServicesHandle } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import { deriveControlPlaneBaseUrl } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { resolveRuntimeEndpointBinding, type RuntimeEndpointSettingKey } from './cli-endpoints.js';
export type HostServiceName = 'daemon' | 'httpListener';
/** The settings the pending status reads: the daemon's and the listener's endpoint keys and the control plane's TLS mode. */
type PendingStatusConfigKey = RuntimeEndpointSettingKey<'controlPlane' | 'httpListener'> | 'controlPlane.tls.mode';
export function formatHostServiceBaseUrl(host: string, port: number): string {
  const normalized = host.trim().toLowerCase();
  const probe = normalized === '0.0.0.0' ? '127.0.0.1' : normalized === '::' || normalized === '[::]' ? '::1' : host;
  const urlHost = probe.includes(':') && !probe.startsWith('[') ? `[${probe}]` : probe;
  return `http://${urlHost}:${port}`;
}
/**
 * Where a service would be before discovery has answered: the address the
 * platform's bind rule gives its settings. The daemon's URL is the control
 * plane's loopback URL (scheme from its TLS mode); the listener's comes from
 * the caller's probe formatter.
 */
export function pendingHostServiceStatus(
  config: { get(key: PendingStatusConfigKey): unknown },
  service: HostServiceName,
  policy: { readonly url: (host: string, port: number) => string; readonly reason: string },
): HostServiceStatus {
  const binding = resolveRuntimeEndpointBinding(config, service === 'daemon' ? 'controlPlane' : 'httpListener');
  const baseUrl = service === 'daemon'
    ? deriveControlPlaneBaseUrl({
      hostMode: binding.hostMode,
      host: binding.host,
      port: binding.port,
      tlsMode: String(config.get('controlPlane.tls.mode') ?? 'off'),
    })
    : policy.url(binding.host, binding.port);
  return { mode: 'unavailable', host: binding.host, port: binding.port, baseUrl, reason: policy.reason };
}
export function createPendingHostServices(status: (name: HostServiceName) => HostServiceStatus): HostServicesHandle {
  return {
    httpListener: null,
    daemonStatus: status('daemon'),
    httpListenerStatus: status('httpListener'),
    async stop(): Promise<void> {},
  };
}
export const hostServiceIsActive = (status: HostServiceStatus): boolean => status.mode === 'embedded' || status.mode === 'external';
export const hostServiceIsBlocked = (status: HostServiceStatus): boolean => status.mode === 'blocked' || status.mode === 'incompatible';
