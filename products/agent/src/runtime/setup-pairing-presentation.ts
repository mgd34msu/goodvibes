import type { AgentHostPairingResult } from './agent-host-pairing.ts';

/** What each outcome is called on screen; the status id stays what JSON output and scripts read. */
const HEADINGS: Readonly<Record<AgentHostPairingResult['status'], string>> = {
  blocked: 'Pairing cannot start',
  'already-paired': 'Already paired',
  cancelled: 'Pairing cancelled',
  changed: 'Something changed: nothing was kept',
  unknown: 'Pairing outcome not known',
  cleared: 'Forgotten',
  paired: 'Paired',
  'no-host-configured': 'No host to pair with',
  'pairing-store-unreadable': 'The pairing file cannot be read',
  'credential-rejected': 'The host refused this key',
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
    `  ${result.message}`,
  ].join('\n');
}
