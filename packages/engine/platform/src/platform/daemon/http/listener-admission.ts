/**
 * What the control-plane listener answers before any route sees a request.
 *
 * Two settings decide it, read on each request (an integer-cheap config read):
 *
 * - `controlPlane.enabled`: whether the control plane is served to other
 *   machines. Off, a request is answered only when it comes from this machine
 *   (a loopback peer or one of this machine's own addresses), whatever
 *   `controlPlane.hostMode` binds; a request from anywhere else is refused with
 *   the setting named. The outbound relay has its own switch and does not pass
 *   through the listener, so it is not affected.
 * - `controlPlane.streamMode`: which live update stream is served. `sse`
 *   serves `GET /api/control-plane/events` only, `websocket` serves the
 *   `/api/control-plane/ws` upgrade only, `both` serves both.
 */
import { networkInterfaces } from 'node:os';
import type { ControlPlaneStreamingMode } from '../../control-plane/types.js';
import { isLoopbackHost } from '../../utils/reachable-base-url.js';
import { jsonErrorResponse } from './error-response.js';

export const CONTROL_PLANE_EVENTS_PATH = '/api/control-plane/events';
export const CONTROL_PLANE_SOCKET_PATH = '/api/control-plane/ws';

/** The setting as served; an unreadable value serves both rather than cutting a client off. */
export function readControlPlaneStreamingMode(value: unknown): ControlPlaneStreamingMode {
  return value === 'sse' || value === 'websocket' ? value : 'both';
}

/** This machine's own interface addresses, read at most every 30 s (they change with DHCP or a VPN). */
const OWN_ADDRESS_TTL_MS = 30_000;
let ownAddresses: { readonly at: number; readonly set: ReadonlySet<string> } | null = null;

function normalizeAddress(address: string): string {
  let value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice('::ffff:'.length) : value;
}

function isOwnAddress(address: string): boolean {
  const now = Date.now();
  if (ownAddresses === null || now - ownAddresses.at > OWN_ADDRESS_TTL_MS) {
    const set = new Set<string>();
    try {
      for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) set.add(normalizeAddress(entry.address));
      }
    } catch {
      // No interface list: only loopback counts as this machine.
    }
    ownAddresses = { at: now, set };
  }
  return ownAddresses.set.has(address);
}

/**
 * Whether an address is this machine. `unknown` is a request with no network
 * peer at all (an in-process caller), which is this machine by definition.
 */
export function isThisMachine(address: string | undefined): boolean {
  if (address === undefined || address === 'unknown') return true;
  const normalized = normalizeAddress(address);
  if (normalized.length === 0) return true;
  // Loopback is decided without the interface list, so the common case reads nothing.
  return isLoopbackHost(normalized) || isOwnAddress(normalized);
}

export interface ListenerAdmissionInput {
  /** `controlPlane.enabled`. */
  readonly servesOtherMachines: boolean;
  /** `controlPlane.streamMode`, as read by {@link readControlPlaneStreamingMode}. */
  readonly streamMode: ControlPlaneStreamingMode;
  /** The socket peer. */
  readonly peerAddress: string | undefined;
  /** The client the listener resolved (the forwarded one when a proxy is trusted). */
  readonly clientAddress: string;
}

/** The refusal for a request this listener does not serve, or null to let it through. */
export function refuseUnservedListenerRequest(req: Request, input: ListenerAdmissionInput): Response | null {
  // Both the socket and a trusted forwarded client must be this machine: a
  // forwarding header alone is whatever the sender wrote.
  if (!input.servesOtherMachines && !(isThisMachine(input.peerAddress) && isThisMachine(input.clientAddress))) {
    return jsonErrorResponse({
      error: 'This daemon serves only its own machine',
      code: 'CONTROL_PLANE_LOCAL_ONLY',
      state: `controlPlane.enabled is off, so a request from ${input.clientAddress} is not served`,
      next: [
        'On the daemon machine run `goodvibes-daemon config set controlPlane.enabled true` to serve other machines',
        'Or reach the daemon through the relay (relay.enabled), which needs no inbound connection',
      ],
    }, { status: 403 });
  }
  if (input.streamMode === 'both' || req.method !== 'GET') return null;
  const { pathname } = new URL(req.url);
  if (pathname === CONTROL_PLANE_SOCKET_PATH && input.streamMode === 'sse') {
    return jsonErrorResponse({
      error: 'This daemon serves live updates over Server-Sent Events, not WebSocket',
      code: 'STREAM_MODE_NOT_SERVED',
      state: 'controlPlane.streamMode is sse, so the WebSocket stream is not served',
      next: [`Read GET ${CONTROL_PLANE_EVENTS_PATH} instead`, 'Or set controlPlane.streamMode to websocket or both'],
    }, { status: 409 });
  }
  if (pathname === CONTROL_PLANE_EVENTS_PATH && input.streamMode === 'websocket') {
    return jsonErrorResponse({
      error: 'This daemon serves live updates over WebSocket, not Server-Sent Events',
      code: 'STREAM_MODE_NOT_SERVED',
      state: 'controlPlane.streamMode is websocket, so the Server-Sent Events stream is not served',
      next: [`Open the WebSocket at ${CONTROL_PLANE_SOCKET_PATH} instead`, 'Or set controlPlane.streamMode to sse or both'],
    }, { status: 409 });
  }
  return null;
}
