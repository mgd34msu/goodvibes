import type { CommandContext } from '../command-registry.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { generateQrMatrix, renderQrToString } from '@goodvibes-jev/engine/platform/platform/pairing';

/**
 * Register the /relay command, the relay's configuration, its reachability
 * state, and a QR-encodable pairing payload for the platform's outbound
 * zero-knowledge relay (relay.* settings, gated by the `relay-connect` feature
 * flag).
 *
 * The CONFIGURATION half is read here, from this terminal's own config. The
 * LIVE half (registration state and the pairing payload) lives in the running
 * daemon and is asked for through its relay verbs, one request per command; see
 * relay-reachability-bridge.ts. 'unavailable' means only that the daemon could
 * not be asked, and the reason is printed.
 */

function relayConfigured(ctx: CommandContext): { enabled: boolean; url: string; rendezvousId: string; label: string; flagOn: boolean } {
  const config = ctx.platform.configManager;
  return {
    enabled: config.get('relay.enabled') === true,
    url: String(config.get('relay.url') ?? ''),
    rendezvousId: String(config.get('relay.rendezvousId') ?? ''),
    label: String(config.get('relay.label') ?? ''),
    flagOn: ctx.platform.featureFlagManager?.isEnabled('relay-connect') ?? false,
  };
}

async function renderStatus(ctx: CommandContext): Promise<void> {
  const cfg = relayConfigured(ctx);
  if (!cfg.enabled || !cfg.flagOn) {
    ctx.print([
      'Relay: disabled',
      `  relay.enabled: ${cfg.enabled ? 'yes' : 'no'}`,
      `  relay-connect flag: ${cfg.flagOn ? 'on' : 'off'}`,
      '  Both must be on for outbound relay reachability. See /config relay.',
    ].join('\n'));
    return;
  }
  const reading = ctx.platform.externalServices
    ? await ctx.platform.externalServices.relayStatus()
    : { status: 'unavailable' as const, reason: 'the background service controller is not running in this build' };
  ctx.print([
    `Relay: ${reading.status}`,
    `  rendezvous id: ${cfg.rendezvousId || '(not yet minted; start the daemon to generate one)'}`,
    `  url: ${cfg.url || '(not set)'}`,
    `  label: ${cfg.label || '(not set)'}`,
    reading.status === 'unavailable'
      ? `  The daemon holds the relay connection and could not be asked: ${reading.reason ?? 'no reason was given'}. Check the daemon with /status.`
      : reading.status === 'disabled'
        ? '  The daemon reports a relay gate off: relay.enabled, the relay-connect flag or relay.url on the daemon\'s machine.'
        : `  live connection state (from the daemon): ${reading.status}`,
    '  The relay operator sees only ciphertext and connection metadata; self-host your own relay for full control.',
  ].join('\n'));
}

async function renderPair(ctx: CommandContext): Promise<void> {
  const cfg = relayConfigured(ctx);
  if (!cfg.enabled || !cfg.flagOn) {
    ctx.print('Relay is disabled: turn on relay.enabled in /config relay first.');
    return;
  }
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) {
    ctx.print('Relay pairing is unavailable: background service controller is not running in this build.');
    return;
  }
  const reading = await externalServices.mintRelayPairing();
  if (!reading.minted) {
    ctx.print('reason' in reading
      ? `Relay pairing could not be minted: the daemon could not be asked (${reading.reason}). Check the daemon with /status.`
      : `Relay pairing could not be minted: the daemon has no live relay registration yet (state: ${reading.status}). Run /relay status, and try again once it reads registered.`);
    return;
  }
  const qrMatrix = generateQrMatrix(reading.minted.encoded);
  ctx.print([
    'Relay pairing payload (scan with a companion app, or copy the string below):',
    '',
    reading.minted.encoded,
    '',
    renderQrToString(qrMatrix),
  ].join('\n'));
}

export function registerRelayRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'relay',
    description: 'Outbound relay reachability status, or mint a QR-encodable pairing payload',
    usage: '[status|pair]',
    argsHint: '[status|pair]',
    async handler(args, ctx) {
      const sub = args[0]?.toLowerCase();
      if (sub === 'pair') return renderPair(ctx);
      if (sub === undefined || sub === 'status') return renderStatus(ctx);
      ctx.print(`Unknown /relay subcommand: ${sub}. Use: status | pair`);
    },
  });
}
