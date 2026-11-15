/** Read-only shell inspection; unset display values have explicit defaults. */
export interface InspectableDomain {
  readonly name: string;
  getState(): Record<string, unknown>;
  getRevision(): number;
  getLastUpdatedAt(): number;
}

// One implementation of the inbound TLS rules (an unknown mode is reported not ready) and of the
// forwarded-address rule, shared with the daemon listeners.
export type { InboundServerSurface, InboundTlsMode, InboundTlsSnapshot } from './network/inbound.js';
export { inspectInboundTls } from './network/inbound.js';
export { extractForwardedClientIp } from './network/shared.js';
