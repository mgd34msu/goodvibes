import { isIP } from 'node:net';
import type { RuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';

export type BindPostureKind = 'local' | 'local-network' | 'custom-network';

export interface BindPosture {
  readonly kind: BindPostureKind;
  readonly label: string;
  readonly networkFacing: boolean;
}

/** Loopback means the 127.0.0.0/8 block, ::1 or its IPv4-mapped form; a hostname that merely starts with "127." is a name someone else may resolve. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  if (normalized === 'localhost') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  const address = mapped ? mapped[1]! : normalized;
  if (isIP(address) === 4) return address.startsWith('127.');
  return isIP(address) === 6 && /^(?:0{1,4}:){7}0{0,3}1$|^::1$/u.test(address);
}

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
