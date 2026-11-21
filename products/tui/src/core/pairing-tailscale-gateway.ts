// ---------------------------------------------------------------------------
// pairing-tailscale-gateway.ts
//
// The tailscale verbs the pairing surfaces drive, a read-only detection
// (tailscale.get), the one-action serve (tailscale.serve.run) and its stop
// (tailscale.serve.stop), over the
// same generic operator invoke path the fleet acts use (resolveOperatorRpc ->
// platform.operator.invoke), reaching the SAME daemon the command layer does.
//
// They degrade QUIETLY: when no daemon is reachable, the probe resolves to null
// (the pairing surface renders no tailscale affordance at all). Absence is
// never a nag; a probe the daemon answered with a failure rejects, and the
// surface shows the reason in one dim row.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { resolveOperatorRpc } from '../runtime/client/operator-endpoint.ts';
import type {
  PairingTailscaleServeReceipt,
  PairingTailscaleStatus,
  PairingTailscaleStopResult,
} from '../views/modals/pairing-modal.ts';

export interface PairingTailscaleGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/**
 * Probe tailscale (tailscale.get). Returns the honest status, or null when no
 * daemon is reachable (the pairing surface then stays quiet). A failed call
 * throws, so the surface can say why the check failed.
 */
export async function probePairingTailscale(
  deps: PairingTailscaleGatewayDeps,
): Promise<PairingTailscaleStatus | null> {
  const rpc = resolveOperatorRpc(deps);
  if (!rpc.available) return null;
  return (await rpc.platformClient.operator.invoke('tailscale.get', {})) as PairingTailscaleStatus;
}

/**
 * Run tailscale.serve.run and return its receipt. Null when the daemon is
 * unreachable; a failed serve returns a receipt with `ok:false` and an honest
 * detail (never a throw the surface has to guess about).
 */
export async function runPairingTailscaleServe(
  deps: PairingTailscaleGatewayDeps,
): Promise<PairingTailscaleServeReceipt | null> {
  const rpc = resolveOperatorRpc(deps);
  if (!rpc.available) return null;
  const result = (await rpc.platformClient.operator.invoke('tailscale.serve.run', {})) as {
    readonly receipt: PairingTailscaleServeReceipt;
  };
  return result.receipt;
}

/**
 * Run tailscale.serve.stop: turn off the serve this daemon started and put
 * web.publicBaseUrl back. Null when the daemon is unreachable; a failed stop
 * returns a receipt with `ok:false` and the daemon's own detail.
 */
export async function stopPairingTailscaleServe(
  deps: PairingTailscaleGatewayDeps,
): Promise<PairingTailscaleStopResult | null> {
  const rpc = resolveOperatorRpc(deps);
  if (!rpc.available) return null;
  return (await rpc.platformClient.operator.invoke('tailscale.serve.stop', {})) as PairingTailscaleStopResult;
}
