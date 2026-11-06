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
export const TUI_HOST_PAIRING_MAX_RECORDS = HOST_PAIRING_MAX_RECORDS;
export const TUI_HOST_PAIRING_MAX_BYTES = HOST_PAIRING_MAX_BYTES;
export const TUI_HOST_PAIRING_UNAVAILABLE_REASON = 'TUI host credential store is unavailable.';
export type TuiHostPairingAttempt = HostPairingAttempt;
export type TuiHostPairingSecret = HostPairingSecret;
export type TuiHostPairingUnavailable = HostPairingUnavailable<typeof TUI_HOST_PAIRING_UNAVAILABLE_REASON>;
export type TuiHostPairing = HostPairing<typeof TUI_HOST_PAIRING_UNAVAILABLE_REASON>;
export type BeginTuiHostPairingResult = BeginHostPairingResult<typeof TUI_HOST_PAIRING_UNAVAILABLE_REASON, true>;
export type CompleteTuiHostPairingResult = CompleteHostPairingResult<typeof TUI_HOST_PAIRING_UNAVAILABLE_REASON>;
export type TuiHostPairingIO = HostPairingIO;
export const {
  canonicalizePairingHost,
  hostPairingStorePath: tuiHostPairingStorePath,
  readHostPairing: readTuiHostPairing,
  beginHostPairing: beginTuiHostPairing,
  completeHostPairing: completeTuiHostPairing,
} = createHostPairingStore({
  unavailableReason: TUI_HOST_PAIRING_UNAVAILABLE_REASON,
  surfaceRoot: 'tui',
  directory: 'connected-host-credentials',
  filename: 'credentials.json',
  strictOrigin: true,
});
