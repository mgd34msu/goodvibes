import type { HostServiceStatus, HostServicesHandle } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
export type HostServiceName = 'daemon' | 'httpListener';
export function formatHostServiceBaseUrl(host: string, port: number): string {
  const normalized = host.trim().toLowerCase();
  const probe = normalized === '0.0.0.0' ? '127.0.0.1' : normalized === '::' || normalized === '[::]' ? '::1' : host;
  const urlHost = probe.includes(':') && !probe.startsWith('[') ? `[${probe}]` : probe;
  return `http://${urlHost}:${port}`;
}
export function pendingHostServiceStatus(
  config: { get(key: 'controlPlane.host' | 'httpListener.host' | 'controlPlane.port' | 'httpListener.port'): unknown },
  service: HostServiceName,
  policy: { readonly url: (host: string, port: number) => string; readonly reason: string },
): HostServiceStatus {
  const host = String(config.get(service === 'daemon' ? 'controlPlane.host' : 'httpListener.host') ?? '127.0.0.1');
  const port = Number(config.get(service === 'daemon' ? 'controlPlane.port' : 'httpListener.port') ?? (service === 'daemon' ? 3421 : 3422));
  return { mode: 'unavailable', host, port, baseUrl: policy.url(host, port), reason: policy.reason };
}
export function createPendingHostServices(status: (name: HostServiceName) => HostServiceStatus): HostServicesHandle {
  return {
    daemonServer: null,
    httpListener: null,
    daemonStatus: status('daemon'),
    httpListenerStatus: status('httpListener'),
    listRecentControlPlaneEvents: () => [],
    async stop(): Promise<void> {},
  };
}
export const hostServiceIsActive = (status: HostServiceStatus): boolean => status.mode === 'embedded' || status.mode === 'external';
export const hostServiceIsBlocked = (status: HostServiceStatus): boolean => status.mode === 'blocked' || status.mode === 'incompatible';
