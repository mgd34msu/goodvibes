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
  type RemoveHostPairingResult,
  type HostPairingIO,
} from '../host-pairing-store.js';
export const AGENT_HOST_PAIRING_MAX_RECORDS = HOST_PAIRING_MAX_RECORDS;
export const AGENT_HOST_PAIRING_MAX_BYTES = HOST_PAIRING_MAX_BYTES;
export const AGENT_HOST_PAIRING_UNAVAILABLE_REASON = 'Agent host pairing store is unavailable.';
export type AgentHostPairingAttempt = HostPairingAttempt;
export type AgentHostPairingSecret = HostPairingSecret;
export type AgentHostPairingUnavailable = HostPairingUnavailable<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON>;
export type AgentHostPairing = HostPairing<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON>;
export type BeginAgentHostPairingResult = BeginHostPairingResult<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON, false>;
export type CompleteAgentHostPairingResult = CompleteHostPairingResult<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON>;
export type RemoveAgentHostPairingResult = RemoveHostPairingResult<typeof AGENT_HOST_PAIRING_UNAVAILABLE_REASON>;
export type AgentHostPairingIO = HostPairingIO;
/** An unreadable pairing in plain words: what failed and what to do (the store's own detail). */
export function describeUnreadableAgentHostPairing(pairing: AgentHostPairingUnavailable): string {
  const detail = pairing.reason.startsWith(AGENT_HOST_PAIRING_UNAVAILABLE_REASON)
    ? pairing.reason.slice(AGENT_HOST_PAIRING_UNAVAILABLE_REASON.length).trim()
    : pairing.reason;
  return `This Agent's saved pairing with the GoodVibes host could not be read.${detail ? ` ${detail}` : ''}`;
}
export const {
  canonicalizePairingHost,
  hostPairingStorePath: agentHostPairingStorePath,
  readHostPairing: readAgentHostPairing,
  beginHostPairing: beginAgentHostPairing,
  completeHostPairing: completeAgentHostPairing,
  clearHostPairingAttempt: clearAgentHostPairingAttempt,
  removeHostPairing: removeAgentHostPairing,
} = createHostPairingStore({
  unavailableReason: AGENT_HOST_PAIRING_UNAVAILABLE_REASON,
  surfaceRoot: 'agent',
  directory: 'connected-host-pairings',
  filename: 'pairings.json',
  strictOrigin: false,
});
