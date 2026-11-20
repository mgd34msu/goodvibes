import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/utils/reachable-base-url';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveWebUiListener } from '@goodvibes-jev/engine/platform/platform/pairing';
import { resolveRuntimeEndpointBinding, type RuntimeEndpointBinding } from './cli-endpoints.js';

export type BindPostureKind = 'local' | 'local-network' | 'custom-network';

export interface BindPosture {
  readonly kind: BindPostureKind;
  readonly label: string;
  readonly networkFacing: boolean;
}

export { isLoopbackHost };

export function classifyBindPosture(binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>): BindPosture {
  if (binding.hostMode === 'local' || isLoopbackHost(binding.host)) {
    return {
      kind: 'local',
      label: 'Local only',
      networkFacing: false,
    };
  }
  if (binding.hostMode === 'network' || binding.host === '0.0.0.0' || binding.host === '::') {
    return {
      kind: 'local-network',
      label: 'Local Network',
      networkFacing: true,
    };
  }
  return {
    kind: 'custom-network',
    label: 'Custom network',
    networkFacing: true,
  };
}

export function isNetworkFacing(
  enabled: unknown,
  binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>,
): boolean {
  return enabled === true && classifyBindPosture(binding).networkFacing;
}

/**
 * The web UI's network exposure, from the listener that actually serves it
 * (the engine's one owner of that address, `resolveWebUiListener`): while the
 * daemon serves the bundle it is the control-plane listener, network-facing
 * only when that listener is bound beyond loopback and `controlPlane.enabled`
 * lets other machines in. With no bundle served nothing serves it, whatever
 * `web.hostMode`, `web.host` or `web.port` say: those are a development
 * server's, and a setting only a development server binds is never exposure.
 */
export function resolveWebSurfaceExposure(config: Pick<ConfigManager, 'get'>): {
  readonly served: boolean;
  /** The control-plane binding while served; the development endpoint otherwise, for display only. */
  readonly binding: RuntimeEndpointBinding;
  readonly networkFacing: boolean;
} {
  if (resolveWebUiListener(config) === null) {
    return { served: false, binding: resolveRuntimeEndpointBinding(config, 'web'), networkFacing: false };
  }
  const binding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  return { served: true, binding, networkFacing: isNetworkFacing(config.get('controlPlane.enabled') === true, binding) };
}
