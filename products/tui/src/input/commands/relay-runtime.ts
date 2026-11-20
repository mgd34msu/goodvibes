import type { CommandContext } from '../command-registry.ts';
import type { RelayCode } from '@goodvibes-jev/engine/terminal-shell/devices-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { generateQrMatrix, renderQrToString } from '@goodvibes-jev/engine/platform/platform/pairing/qr-generator';
import type { RelayRefusal, RelayStatusReading } from '../../runtime/relay-reachability-bridge.ts';

/**
 * The relay actions of /devices (terminal-shell/devices-command.ts) in this
 * app: the relay's configuration, its reachability state, a QR-encodable
 * pairing payload for the platform's outbound zero-knowledge relay (relay.*
 * settings, gated by the `relay-connect` feature flag), and the relay codes.
 *
 * The CONFIGURATION half is read here, from this terminal's own config. The
 * LIVE half (registration state and the pairing payload) lives in the running
 * daemon and is asked for through its relay verbs, one request per command; see
 * relay-reachability-bridge.ts. 'unavailable' means only that the daemon could
 * not be asked, and the reason is printed.
 */

function relayConfigured(ctx: CommandContext): { enabled: boolean; url: string; label: string; flagOn: boolean } {
  const config = ctx.platform.configManager;
  return {
    enabled: config.get('relay.enabled') === true,
    url: String(config.get('relay.url') ?? ''),
    label: String(config.get('relay.label') ?? ''),
    flagOn: ctx.platform.featureFlagManager?.isEnabled('relay-connect') ?? false,
  };
}

/** The relay's refusal of the daemon's registration: why, whether the daemon keeps trying, and what to do. */
function refusalLines(refusal: RelayRefusal | undefined): string[] {
  if (!refusal) return [];
  return [
    `  refused by the relay (${refusal.code}): ${refusal.state}${refusal.message ? ` (${refusal.message})` : ''}`,
    refusal.retryable
      ? '  The daemon keeps trying through its reconnect backoff.'
      : '  The daemon stopped dialling the relay; it tries again when relay.url changes or when the daemon restarts.',
    ...refusal.next.map((step) => `  next: ${step}`),
  ];
}

export async function relayStatus(ctx: CommandContext): Promise<string> {
  const cfg = relayConfigured(ctx);
  if (!cfg.enabled || !cfg.flagOn) {
    return [
      'Relay: disabled',
      `  relay.enabled: ${cfg.enabled ? 'yes' : 'no'}`,
      `  relay-connect flag: ${cfg.flagOn ? 'on' : 'off'}`,
      '  Both must be on for outbound relay reachability. See /settings open relay.',
    ].join('\n');
  }
  const reading: RelayStatusReading = ctx.platform.externalServices
    ? await ctx.platform.externalServices.relayStatus()
    : { status: 'unavailable' as const, reason: 'the background service controller is not running in this build' };
  return [
    `Relay: ${reading.status}`,
    `  rendezvous id: ${reading.rendezvousId ?? '(none: the daemon has no live registration; it is derived from the daemon\'s relay identity key once one starts)'}`,
    `  url: ${cfg.url || '(not set)'}`,
    `  label: ${cfg.label || '(not set)'}`,
    reading.status === 'unavailable'
      ? `  The daemon holds the relay connection and could not be asked: ${reading.reason ?? 'no reason was given'}. Check the daemon with /status.`
      : reading.status === 'disabled'
        ? '  The daemon reports a relay gate off: relay.enabled, the relay-connect flag or relay.url on the daemon\'s machine.'
        : `  live connection state (from the daemon): ${reading.status}`,
    ...refusalLines(reading.refusal),
    '  The relay operator sees only ciphertext and connection metadata; self-host your own relay for full control.',
  ].join('\n');
}

export async function pairRelay(ctx: CommandContext, name: string | undefined): Promise<string> {
  const cfg = relayConfigured(ctx);
  if (!cfg.enabled || !cfg.flagOn) throw commandRefusal('Relay is disabled: turn on relay.enabled in /settings open relay first.');
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) throw commandRefusal('Relay pairing is unavailable: background service controller is not running in this build.');
  const reading = await externalServices.mintRelayPairing(name);
  if (!reading.minted) {
    throw commandRefusal('reason' in reading
      ? `Relay pairing could not be minted: the daemon could not be asked (${reading.reason}). Check the daemon with /status.`
      : `Relay pairing could not be minted: the daemon has no live relay registration yet (state: ${reading.status}). Run /devices relay-status, and try again once it reads registered.`);
  }
  const qrMatrix = generateQrMatrix(reading.minted.encoded);
  return [
    'Relay pairing payload (scan with a companion app, or copy the string below):',
    '',
    reading.minted.encoded,
    '',
    renderQrToString(qrMatrix),
    '',
    `It carries a relay code for one device${reading.minted.codeName ? `, "${reading.minted.codeName}"` : ''}${reading.minted.codeId ? ` (${reading.minted.codeId})` : ''}.`,
    'Pair each device with its own code. /devices relay-codes lists them; /devices relay-revoke <code> cuts one device off the relay at its next request.',
  ].join('\n');
}

export async function relayCodes(ctx: CommandContext): Promise<readonly RelayCode[]> {
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) throw commandRefusal('Relay codes are unavailable: background service controller is not running in this build.');
  const reading = await externalServices.listRelayCodes();
  if (reading.codes === null) throw commandRefusal(`Relay codes could not be read: the daemon could not be asked (${reading.reason}). Check the daemon with /status.`);
  return reading.codes;
}

export async function revokeRelayCode(ctx: CommandContext, id: string): Promise<string> {
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) throw commandRefusal('Relay codes are unavailable: background service controller is not running in this build.');
  const reading = await externalServices.revokeRelayCode(id);
  if (!reading.revoked) throw commandRefusal(`Relay code ${id} was not revoked: ${reading.reason}`);
  return `Relay code ${reading.id} revoked: that device is refused at its next request through the relay. Pair it again on the home network to restore it.`;
}
