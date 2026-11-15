import type { AcpConnection } from '../store/domains/acp.js';
import type { RemoteRunnerContract } from './types.js';

export interface RemoteHeartbeatSnapshot {
  readonly status: 'fresh' | 'stale' | 'offline';
  readonly lastSeenAt?: number | undefined;
  readonly ageMs?: number | undefined;
  readonly detail: string;
}

export function deriveRemoteHeartbeat(
  connection?: AcpConnection | null,
  contract?: RemoteRunnerContract | null,
): RemoteHeartbeatSnapshot {
  const lastSeenAt = connection?.connectedAt ?? contract?.transport.connectedAt;
  if (!lastSeenAt) {
    return {
      status: 'offline',
      detail: 'No heartbeat has been observed yet.',
    };
  }
  const ageMs = Math.max(0, Date.now() - lastSeenAt);
  const state = connection?.transportState ?? contract?.transport.state;
  if (state === 'terminal_failure' || state === 'disconnected') {
    return {
      status: 'offline',
      lastSeenAt,
      ageMs,
      detail: 'Transport is offline and requires reattach or redispatch.',
    };
  }
  // Only the time of connection is recorded, never the last message, so age
  // since connecting says nothing about whether the remote is still answering.
  // The transport state is what the engine knows: it moves to degraded or
  // reconnecting when contact is lost, and back to connected when it returns.
  if (state === 'degraded' || state === 'reconnecting') {
    return {
      status: 'stale',
      lastSeenAt,
      ageMs,
      detail: `Transport is ${state}; remote recovery should be reviewed.`,
    };
  }
  return {
    status: 'fresh',
    lastSeenAt,
    ageMs,
    detail: 'Transport is connected; the age shown is the time since it connected, not since the last message.',
  };
}
