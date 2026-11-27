import type { CommandContext } from '../command-registry.ts';
import type { RelayCode } from '@goodvibes/engine/terminal-shell/devices-command';
import type { PairingAnswer } from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { askToTurnOnRelay } from '@goodvibes/engine/terminal-shell/relay-pairing-ask';
import { generateQrMatrix, renderQrToString } from '@goodvibes/engine/platform/platform/pairing/qr-generator';

/**
 * Pairing a device through the relay in this app (Pair something, terminal-shell/devices-command.ts): a
 * QR-encodable pairing payload for the platform's outbound zero-knowledge relay (relay.* settings, gated by the
 * `relay-connect` feature flag), and the relay codes a form chooses from. The relay's reachability, its codes and
 * cutting a device off are the daemon's capabilities, in the Devices place (platform capabilities/builtin/devices.ts).
 *
 * The LIVE half (registration state and the pairing payload) lives in the running daemon and is asked for through
 * its relay verbs, one request per command; see relay-reachability-bridge.ts.
 */

function relayConfiguredUrl(ctx: CommandContext): string {
  return String(ctx.platform.configManager.get('relay.url') ?? '');
}

export async function pairRelay(ctx: CommandContext, name: string | undefined): Promise<PairingAnswer> {
  const configuredUrl = relayConfiguredUrl(ctx);
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) throw commandRefusal('Relay pairing is unavailable: background service controller is not running in this build.');
  // The daemon's relay off: asked in place (opening on No), with the relay's address in the same step when
  // none is set; yes turns it on and the same call waits for the host to register, then pairs (relay.pairing.mint).
  const confirm = ctx.confirm;
  const ask = confirm
    ? async (url: string) => {
      const said = await askToTurnOnRelay(confirm, url);
      if (said.turnOn) {
        const address = said.url || url;
        ctx.print(`The relay is on at ${address || 'the address set on the daemon'}, and it is not answering yet. The pairing shows here as soon as it does; you can carry on meanwhile.`);
      }
      return said;
    }
    : undefined;
  const reading = await externalServices.mintRelayPairing(name, { ask, configuredUrl });
  if (!reading.minted) {
    throw commandRefusal('reason' in reading
      ? `Relay pairing could not be minted: the daemon could not be asked (${reading.reason}). Check the daemon with /status.`
      : reading.status === 'disabled'
        ? 'No relay pairing was made: the relay is off on the daemon, and it was left off.'
        : `Relay pairing could not be minted: the relay ${reading.status === 'refused' ? 'refused the daemon\'s registration' : 'registration did not succeed'} (state: ${reading.status}). The Relay tab of Devices and network says why.`);
  }
  const qrMatrix = generateQrMatrix(reading.minted.encoded);
  // The payload carries the relay code: it and its QR code are shown once, in the reveal pane, never in these words.
  return {
    text: [
      `A relay pairing payload was made for one device${reading.minted.codeName ? `, "${reading.minted.codeName}"` : ''}${reading.minted.codeId ? ` (${reading.minted.codeId})` : ''}: scan its QR code with a companion app, or copy it, from the pane.`,
      'Pair each device with its own code. The Relay tab of Devices and network lists them and cuts one device off the relay at its next request.',
    ].join('\n'),
    reveal: { value: reading.minted.encoded, qr: renderQrToString(qrMatrix) },
  };
}

export async function relayCodes(ctx: CommandContext): Promise<readonly RelayCode[]> {
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) throw commandRefusal('Relay codes are unavailable: background service controller is not running in this build.');
  const reading = await externalServices.listRelayCodes();
  if (reading.codes === null) throw commandRefusal(`Relay codes could not be read: the daemon could not be asked (${reading.reason}). Check the daemon with /status.`);
  return reading.codes;
}
