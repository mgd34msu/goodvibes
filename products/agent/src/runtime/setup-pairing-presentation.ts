import type { AgentHostPairingResult } from './agent-host-pairing.ts';

/** What each outcome is called on screen; the status id stays what JSON output and scripts read. */
const HEADINGS: Readonly<Record<AgentHostPairingResult['status'], string>> = {
  preview: 'Pair this Agent with its host',
  blocked: 'Pairing cannot start',
  'already-paired': 'Already paired',
  cancelled: 'Pairing cancelled',
  changed: 'Something changed: nothing was sent',
  unknown: 'Pairing outcome not known',
  rejected: 'The host refused to pair',
  cleared: 'Forgotten',
  paired: 'Paired',
  'paired-unverified': 'Paired, not yet confirmed by the host',
  'paired-shadowed': 'Paired, but a key in the environment is used first',
  'no-host-configured': 'No host to pair with',
  'pairing-store-unreadable': 'The pairing file cannot be read',
  'no-credential': 'No key to pair with',
  'credential-rejected': 'The host refused this Agent\'s key',
  'host-unreachable': 'The host cannot be reached',
  'host-timeout': 'The host did not answer',
  'host-lacks-pairing': 'The host is too old to pair',
  'host-error': 'The host failed',
};

export function formatSetupPairing(result: AgentHostPairingResult): string {
  return [
    `Host pairing: ${HEADINGS[result.status]}`,
    ...(result.host ? [`  Host: ${result.host}`] : []),
    ...(result.name ? [`  Device name: ${result.name}`] : []),
    ...(result.scopeDisclosure ? [`  What it allows: ${result.scopeDisclosure}`] : []),
    ...(result.environmentOverride ? ['  A key set in the environment is used before the saved keys, and is left as it is.'] : []),
    `  ${result.message}`,
  ].join('\n');
}
