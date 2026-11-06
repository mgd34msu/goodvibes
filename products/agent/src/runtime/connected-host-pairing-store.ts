import {
  createHostPairingStore,
  HOST_PAIRING_MAX_RECORDS,
  HOST_PAIRING_MAX_BYTES,
  type HostPairingAttempt,
  type HostPairingSecret,
  type HostPairingUnavailable,
  type HostPairing,
  type BeginHostPairingResult,
  type CompleteHostPairingResult,
  type HostPairingIO,
} from '@goodvibes-jev/engine/terminal-shell/host-pairing-store';
export const AGENT_HOST_PAIRING_MAX_RECORDS = HOST_PAIRING_MAX_RECORDS;
export const AGENT_HOST_PAIRING_MAX_BYTES = HOST_PAIRING_MAX_BYTES;
export const AGENT_HOST_PAIRING_UNAVAILABLE_REASON = 'Agent host pairing store is unavailable.';
export type AgentHostPairingAttempt = HostPairingAttempt;
export type AgentHostPairingSecret = HostPairingSecret;
export type AgentHostPairingUnavailable = HostPairingUnavailable<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON>;
export type AgentHostPairing = HostPairing<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON>;
export type BeginAgentHostPairingResult = BeginHostPairingResult<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON, false>;
export type CompleteAgentHostPairingResult = CompleteHostPairingResult<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON>;
export type AgentHostPairingIO = HostPairingIO;
export const {
  canonicalizePairingHost,
  hostPairingStorePath: agentHostPairingStorePath,
  readHostPairing: readAgentHostPairing,
  beginHostPairing: beginAgentHostPairing,
  completeHostPairing: completeAgentHostPairing,
} = createHostPairingStore({
  unavailableReason: AGENT_HOST_PAIRING_UNAVAILABLE_REASON,
  surfaceRoot: 'agent',
  directory: 'connected-host-pairings',
  filename: 'pairings.json',
  strictOrigin: false,
});
