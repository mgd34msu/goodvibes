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
  const lastSeenAt = connection?.connectedAt ?? contract?.transport?.connectedAt;
  if (!lastSeenAt) {
    return {
      status: 'offline',
      detail: 'it has not connected yet',
    };
  }
  const ageMs = Math.max(0, Date.now() - lastSeenAt);
  const state = connection?.transportState ?? contract?.transport?.state;
  if (state === 'terminal_failure' || state === 'disconnected') {
    return {
      status: 'offline',
      lastSeenAt,
      ageMs,
      detail: `the connection is ${state === 'disconnected' ? 'closed' : 'lost for good'}; start the runner again to go on`,
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
      detail: state === 'degraded' ? 'contact with the runner was lost; it may come back' : 'contact with the runner was lost; it is being reconnected',
    };
  }
  // Said to a person: what the runner is doing, never the transport's own state names.
  return {
    status: 'fresh',
    lastSeenAt,
    ageMs,
    detail: state === 'syncing' ? 'it is working and in contact' : state === 'connected' ? 'it is connected and in contact' : 'it is starting',
  };
}
