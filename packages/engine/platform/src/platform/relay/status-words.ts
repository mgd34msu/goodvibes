/**
 * status-words.ts, the relay registration's state in plain words, with the
 * relay's address, for a client to show (relay.reachability.get `words`, also
 * while relay.pairing.mint waits for the host's answer). No imports, so the
 * control-plane routes take it without the relay transport.
 */

/** One sentence for a relay status. */
export function describeRelayStatus(status: string, relayUrl: string, refusal: { readonly state: string } | null | undefined): string {
  const at = relayUrl ? ` at ${relayUrl}` : '';
  switch (status) {
    case 'disabled': return relayUrl ? `The relay is turned off on this machine (relay address ${relayUrl}).` : 'The relay is turned off on this machine: no relay address is set.';
    case 'idle':
    case 'connecting': return `Connecting to the relay${at}: it is not answering yet.`;
    case 'reconnecting': return `The relay${at} is not answering yet; GoodVibes keeps trying.`;
    case 'registered': return `Registered with the relay${at}: devices can reach this machine through it.`;
    case 'refused': return `The relay${at} refused this machine${refusal ? `: ${refusal.state}` : '.'}`;
    case 'failed': return `The relay registration${at} could not start${refusal ? `: ${refusal.state}` : '.'}`;
    default: return `The relay${at} is ${status}.`;
  }
}
