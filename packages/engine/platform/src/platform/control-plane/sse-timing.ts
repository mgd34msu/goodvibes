/**
 * control-plane/sse-timing.ts
 *
 * The server side of the server-sent-events keep-alive timing. The heartbeat
 * interval and the silence deadline live with the stream reader in the HTTP
 * transport, so the daemon's idle timeout and the client's dead-stream
 * deadline are the same number and cannot drift apart.
 *
 * The failure this prevents: Bun.serve's default idleTimeout is 10s, but the SSE
 * heartbeat interval is 15s, so a quiet stream is torn down ~5s BEFORE its first
 * keep-alive frame ever arrives. Deriving the idle timeout from the heartbeat
 * interval (and firing the first heartbeat immediately on open) makes a quiet
 * stream survive indefinitely, and a client that hears nothing for that long
 * knows the path is gone and reconnects.
 */
import { SSE_HEARTBEAT_INTERVAL_MS, sseIdleDeadlineMs } from '@goodvibes-jev/engine/transport-http';

/** The SSE keep-alive heartbeat interval (ms). The gateway fires one immediately on open, then on this cadence. */
export { SSE_HEARTBEAT_INTERVAL_MS };

/**
 * The server idle timeout (seconds, Bun.serve's unit): the silence deadline a
 * client also applies, so even a single dropped/late heartbeat cannot trip the
 * idle cutoff. Clamped to Bun's valid 1..255s range.
 */
export function sseIdleTimeoutSeconds(heartbeatIntervalMs: number = SSE_HEARTBEAT_INTERVAL_MS): number {
  const seconds = Math.ceil(sseIdleDeadlineMs(heartbeatIntervalMs) / 1_000);
  return Math.min(255, Math.max(1, seconds));
}
