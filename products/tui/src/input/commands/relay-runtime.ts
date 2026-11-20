import type { CommandContext } from '../command-registry.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { generateQrMatrix, renderQrToString } from '@goodvibes-jev/engine/platform/platform/pairing/qr-generator';
import type { RelayRefusal, RelayStatusReading } from '../../runtime/relay-reachability-bridge.ts';

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
  const reading: RelayStatusReading = ctx.platform.externalServices
    ? await ctx.platform.externalServices.relayStatus()
    : { status: 'unavailable' as const, reason: 'the background service controller is not running in this build' };
  ctx.print([
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
  ].join('\n'));
}

async function renderPair(ctx: CommandContext, name: string | undefined): Promise<void> {
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
  const reading = await externalServices.mintRelayPairing(name);
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
    '',
    `It carries a relay code for one device${reading.minted.codeName ? `, "${reading.minted.codeName}"` : ''}${reading.minted.codeId ? ` (${reading.minted.codeId})` : ''}.`,
    'Pair each device with its own code. /relay codes lists them; /relay revoke <id> cuts one device off the relay at its next request.',
  ].join('\n'));
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

async function renderCodes(ctx: CommandContext): Promise<void> {
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) {
    ctx.print('Relay codes are unavailable: background service controller is not running in this build.');
    return;
  }
  const reading = await externalServices.listRelayCodes();
  if (reading.codes === null) {
    ctx.print(`Relay codes could not be read: the daemon could not be asked (${reading.reason}). Check the daemon with /status.`);
    return;
  }
  if (reading.codes.length === 0) {
    ctx.print('No relay codes: no device is paired through the relay. /relay pair [name] pairs one.');
    return;
  }
  ctx.print([
    `Relay codes (${reading.codes.length}), one per device paired through the relay:`,
    ...reading.codes.map((code) => `  ${code.id}  ${code.name}  created ${formatTime(code.createdAt)}  ${code.lastSeenAt ? `last used ${formatTime(code.lastSeenAt)}` : 'not used yet'}`),
    '/relay revoke <id> cuts that device off the relay at its next request; every other device keeps working.',
  ].join('\n'));
}

async function renderRevoke(ctx: CommandContext, id: string | undefined): Promise<void> {
  if (!id) {
    ctx.print('Usage: /relay revoke <id>  (the ids are in /relay codes)');
    return;
  }
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) {
    ctx.print('Relay codes are unavailable: background service controller is not running in this build.');
    return;
  }
  const reading = await externalServices.revokeRelayCode(id);
  ctx.print(reading.revoked
    ? `Relay code ${reading.id} revoked: that device is refused at its next request through the relay. Pair it again on the home network to restore it.`
    : `Relay code ${id} was not revoked: ${reading.reason}`);
}

export function registerRelayRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'relay',
    description: 'Outbound relay reachability status, mint a pairing payload for one device, or list and revoke devices\' relay codes',
    usage: '[status|pair [name]|codes|revoke <id>]',
    argsHint: '[status|pair [name]|codes|revoke <id>]',
    async handler(args, ctx) {
      const sub = args[0]?.toLowerCase();
      if (sub === 'pair') return renderPair(ctx, args.slice(1).join(' ').trim() || undefined);
      if (sub === 'codes') return renderCodes(ctx);
      if (sub === 'revoke') return renderRevoke(ctx, args[1]);
      if (sub === undefined || sub === 'status') return renderStatus(ctx);
      ctx.print(`Unknown /relay subcommand: ${sub}. Use: status | pair [name] | codes | revoke <id>`);
    },
  });
}
