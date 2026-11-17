import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { formatDeviceLine, resolveTokenByIdPrefix, shortTokenId } from '@goodvibes-jev/engine/platform/platform/pairing';
import { holdMintedTokenForReveal } from '../../views/modals/devices-modal.ts';
import {
  DEVICE_CAPABILITY_SUBCOMMANDS,
  DEVICE_CAPABILITY_USAGE,
  deviceCapabilityConfirmation,
  isDeviceCapabilitySubcommand,
  runDeviceCapabilitySubcommand,
} from '@goodvibes-jev/engine/terminal-shell/device-capabilities-command';

/**
 * Register the /devices command, manage the per-device pairing tokens minted by
 * the pairing surfaces. Mirrors the pairing.tokens.* gateway verbs the daemon
 * serves (list/rename/revoke/migrate/revoke-shared) so the terminal has the same
 * capability as the web app's device manager.
 *
 *   /devices                      list paired devices (name · created · last-seen · id)
 *   /devices rename <id> <name>   rename a device token (id or unambiguous prefix)
 *   /devices revoke <id>          revoke a device token (asks once first)
 *   /devices migrate-shared [name] mint a per-device token off the legacy shared token;
 *                                 the token is shown in the Paired Devices view, never in the transcript
 *   /devices revoke-shared        revoke the legacy shared token (asks once first)
 *
 * and the paired-phone capabilities the daemon serves (device-capabilities-command.ts):
 *   /devices nodes                phones paired as device nodes and what each can serve
 *   /devices grants               the "always allow" grants
 *   /devices revoke-grant <id>    revoke one (asks once first)
 *   /devices captures             photos and screen captures the daemon is keeping
 *   /devices delete-capture <id>  delete one now (asks once first)
 */
export function registerDevicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'devices',
    aliases: ['device'],
    description: 'Manage paired devices: their tokens, the phones paired as device nodes, always-allow grants and retained captures',
    usage: `[list|rename <id> <name>|revoke <id>|migrate-shared [name]|revoke-shared|${DEVICE_CAPABILITY_USAGE}]`,
    argsHint: '[list|rename|revoke|migrate-shared|revoke-shared|nodes|grants|revoke-grant|captures|delete-capture]',
    subcommands: { list: '', rename: '<id> <new name>', revoke: '<id>', 'migrate-shared': '[name]', 'revoke-shared': '', ...DEVICE_CAPABILITY_SUBCOMMANDS },
    confirm(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (isDeviceCapabilitySubcommand(sub)) return deviceCapabilityConfirmation(args);
      const pairingTokens = ctx.platform.pairingTokens;
      if (!pairingTokens) return undefined;
      if (sub === 'revoke' && args[1]) {
        const resolved = resolveTokenByIdPrefix(pairingTokens.list(), args[1]);
        if (!resolved.ok) return undefined;
        return {
          title: `Revoke device "${resolved.token.name}"?`,
          detail: `Device ${shortTokenId(resolved.token.id)} ("${resolved.token.name}") stops authenticating at once and has to pair again to get a new token.`,
          confirmLabel: 'Revoke',
        };
      }
      if (sub === 'revoke-shared' && !pairingTokens.isLegacyRevoked()) {
        return {
          title: 'Revoke the legacy shared token?',
          detail: `This cannot be undone. ${pairingTokens.list().length === 0
            ? 'No per-device token exists yet, so every device still using the shared token is locked out.'
            : 'Devices still on the shared token are locked out until they pair again.'}`,
          confirmLabel: 'Revoke',
        };
      }
      return undefined;
    },
    async handler(args, ctx) {
      if (await runDeviceCapabilitySubcommand(args, ctx.platform.devices, (message) => ctx.print(message))) return;
      const pairingTokens = ctx.platform.pairingTokens;
      if (!pairingTokens) {
        ctx.print('Device management is unavailable in this runtime (no pairing token service wired).');
        return;
      }
      const sub = (args[0] ?? 'list').toLowerCase();

      if (sub === 'list') {
        renderList(ctx, pairingTokens);
        return;
      }

      if (sub === 'rename') {
        const idOrPrefix = args[1];
        const name = args.slice(2).join(' ').trim();
        if (!idOrPrefix || !name) {
          ctx.print('Usage: /devices rename <id> <new name>');
          return;
        }
        const resolved = resolveTokenByIdPrefix(pairingTokens.list(), idOrPrefix);
        if (!resolved.ok) {
          ctx.print(resolved.reason === 'ambiguous' ? `Ambiguous device id "${idOrPrefix}": use more characters.` : `No device matches "${idOrPrefix}".`);
          return;
        }
        if (!pairingTokens.rename(resolved.token.id, name)) {
          ctx.print(`No device matches "${idOrPrefix}" any more (it was revoked elsewhere); nothing was renamed.`);
          return;
        }
        ctx.print(`Renamed device to "${name}".`);
        return;
      }

      if (sub === 'revoke') {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          ctx.print('Usage: /devices revoke <id>');
          return;
        }
        const resolved = resolveTokenByIdPrefix(pairingTokens.list(), idOrPrefix);
        if (!resolved.ok) {
          ctx.print(resolved.reason === 'ambiguous' ? `Ambiguous device id "${idOrPrefix}": use more characters.` : `No device matches "${idOrPrefix}".`);
          return;
        }
        const revoked = pairingTokens.revoke(resolved.token.id);
        ctx.print(revoked ? `Revoked "${resolved.token.name}": its token stops working immediately.` : `Device "${resolved.token.name}" was already absent.`);
        return;
      }

      if (sub === 'migrate-shared') {
        const name = args.slice(1).join(' ').trim() || 'migrated device';
        const minted = pairingTokens.mintForMigration({ name });
        if (!ctx.openModal) {
          // No view to reveal it in: this display-only line is the one place it is shown.
          ctx.print(`Minted a per-device token "${minted.name}" (id ${shortTokenId(minted.id)}), shown once: ${minted.token}\nPair this device with it, then run /devices revoke-shared to retire the legacy shared token.`);
          return;
        }
        // The credential is shown in the Paired Devices view, masked until revealed, and dropped when it closes.
        holdMintedTokenForReveal(minted);
        ctx.openModal('devices-modal');
        ctx.print(`Minted a per-device token "${minted.name}" (id ${shortTokenId(minted.id)}). Its one-time token is in the Paired Devices view: press Ctrl+V to reveal it. Pair the device with it, then run /devices revoke-shared to retire the legacy shared token.`);
        return;
      }

      if (sub === 'revoke-shared') {
        if (pairingTokens.isLegacyRevoked()) {
          ctx.print('The legacy shared token is already revoked.');
          return;
        }
        pairingTokens.revokeLegacyShared();
        ctx.print('Revoked the legacy shared token; devices still on it must re-pair with their own token.');
        return;
      }

      ctx.print(`Unknown /devices subcommand: ${sub}. Use: list | rename | revoke | migrate-shared | revoke-shared | ${DEVICE_CAPABILITY_USAGE}`);
    },
  });
}

function renderList(ctx: CommandContext, pairingTokens: NonNullable<CommandContext['platform']['pairingTokens']>): void {
  const list = pairingTokens.list();
  const lines: string[] = ['Paired devices:'];
  if (list.length === 0) {
    lines.push('  (none yet: pair one with /pair)');
  } else {
    for (const token of list) lines.push(`  ${formatDeviceLine(token)}`);
  }
  lines.push(
    '',
    pairingTokens.isLegacyRevoked()
      ? 'Legacy shared token: revoked.'
      : 'Legacy shared token: active; run /devices migrate-shared then /devices revoke-shared to retire it.',
  );
  ctx.print(lines.join('\n'));
}
