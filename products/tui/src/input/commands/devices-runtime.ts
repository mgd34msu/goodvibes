import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { formatDeviceLine, resolveTokenByIdPrefix, shortTokenId, type MintedPairingToken, type PublicPairingToken } from '@goodvibes-jev/engine/platform/platform/pairing';
import { readConnectedDaemonOrigin } from '@goodvibes-jev/engine/platform/platform/config/control-plane-base-url';
import { describeOperatorRpcError } from '../../runtime/client/operator-endpoint.ts';
import { holdMintedTokenForReveal } from '../../views/modals/devices-modal.ts';
import { revokeSharedTokenOnDaemon } from '../../runtime/client/shared-token-revocation.ts';
import { getOperatorRpc } from './operator-rpc.ts';
import {
  DEVICE_CAPABILITY_SUBCOMMANDS,
  DEVICE_CAPABILITY_USAGE,
  deviceCapabilityConfirmation,
  isDeviceCapabilitySubcommand,
  runDeviceCapabilitySubcommand,
} from '@goodvibes-jev/engine/terminal-shell/device-capabilities-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

/**
 * The device tokens of the daemon this terminal talks to. Its pairing store is
 * the daemon's: with a daemon reachable every verb goes to it through the
 * operator API (`pairing.tokens.*`), so with `daemon.connectedHost.url` set the
 * daemon there is the one changed. Only when the selected daemon is this
 * machine's and does not answer does the command use this machine's pairing
 * file directly (the daemon reads it when it starts).
 */
interface DeviceTokenStore {
  /** Where the devices are, for the lines printed. */
  readonly where: string;
  list(): Promise<readonly PublicPairingToken[]>;
  legacyRevoked(): Promise<boolean>;
  rename(id: string, name: string): Promise<boolean>;
  revoke(id: string): Promise<boolean>;
  mintForMigration(name: string): Promise<MintedPairingToken>;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { readonly status?: unknown }).status === 404);
}

function deviceTokenStore(ctx: CommandContext): DeviceTokenStore {
  const connected = readConnectedDaemonOrigin((key) => ctx.platform.configManager.get(key));
  const rpc = getOperatorRpc(ctx);
  if (rpc.available) {
    const invoke = <T,>(method: string, input: Record<string, unknown>): Promise<T> =>
      rpc.platformClient.operator.invoke(method as never, input as never) as Promise<T>;
    const listed = () => invoke<{ readonly tokens: readonly PublicPairingToken[]; readonly legacySharedRevoked: boolean }>('pairing.tokens.list', {});
    return {
      where: connected ? `the daemon at ${rpc.origin}` : 'this machine\'s daemon',
      list: async () => (await listed()).tokens,
      legacyRevoked: async () => (await listed()).legacySharedRevoked,
      rename: async (id, name) => {
        try { return (await invoke<{ readonly renamed: boolean }>('pairing.tokens.rename', { id, name })).renamed; }
        catch (error) { if (isNotFound(error)) return false; throw error; }
      },
      revoke: async (id) => {
        try { return (await invoke<{ readonly revoked: boolean }>('pairing.tokens.delete', { id })).revoked; }
        catch (error) { if (isNotFound(error)) return false; throw error; }
      },
      mintForMigration: async (name) => (await invoke<{ readonly token: MintedPairingToken }>('pairing.tokens.migrate', { name })).token,
    };
  }
  if (connected) {
    throw commandRefusal(`The daemon at ${connected.baseUrl} could not be asked about its devices: ${rpc.reason}. Nothing was changed on this machine instead.`,
      'Check the connection to that daemon (/settings daemon), then run the command again', 'NOT_DONE');
  }
  const local = ctx.platform.pairingTokens;
  if (!local) {
    throw commandRefusal('Device management is unavailable in this runtime (no pairing token service wired).', undefined, 'DEVICES_UNAVAILABLE');
  }
  return {
    where: 'this machine (its daemon is not answering; it reads these when it starts)',
    list: async () => local.list(),
    legacyRevoked: async () => local.isLegacyRevoked(),
    rename: async (id, name) => local.rename(id, name),
    revoke: async (id) => local.revoke(id),
    mintForMigration: async (name) => local.mintForMigration({ name }),
  };
}

function unresolvedDevice(reason: string, idOrPrefix: string): Error {
  return reason === 'ambiguous'
    ? commandRefusal(`Ambiguous device id "${idOrPrefix}": use more characters.`, '/devices list shows each device id', 'AMBIGUOUS')
    : commandRefusal(`No device matches "${idOrPrefix}".`, '/devices list shows each device id', 'NOT_FOUND');
}

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
 *   /devices revoke-shared        revoke the shared token (asks once first); the daemon
 *                                 replaces it, so this machine's apps stay signed in
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
    // A device name is free text, kept as typed.
    rawRest: (args) => ((args[0] ?? '').toLowerCase() === 'rename' ? 2 : (args[0] ?? '').toLowerCase() === 'migrate-shared' ? 1 : undefined),
    aliases: ['device'],
    description: 'Manage paired devices: their tokens, the phones paired as device nodes, always-allow grants and retained captures',
    usage: `[list|rename <id> <name>|revoke <id>|migrate-shared [name]|revoke-shared|${DEVICE_CAPABILITY_USAGE}]`,
    argsHint: '[list|rename|revoke|migrate-shared|revoke-shared|nodes|grants|revoke-grant|captures|delete-capture]',
    subcommands: { list: '', rename: '<id> <new name>', revoke: '<id>', 'migrate-shared': '[name]', 'revoke-shared': '', ...DEVICE_CAPABILITY_SUBCOMMANDS },
    confirm(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (isDeviceCapabilitySubcommand(sub)) return deviceCapabilityConfirmation(args);
      const pairingTokens = ctx.platform.pairingTokens;
      const connected = readConnectedDaemonOrigin((key) => ctx.platform.configManager.get(key));
      if (sub === 'revoke' && args[1]) {
        // Another daemon's devices are not on this machine: the question names the id typed and where.
        if (connected || !pairingTokens) {
          return {
            title: `Revoke device ${args[1]}?`,
            detail: `The device whose id starts with ${args[1]} on the daemon at ${connected?.baseUrl ?? 'the selected address'} stops authenticating at once and has to pair again to get a new token.`,
            confirmLabel: 'Revoke',
          };
        }
        const resolved = resolveTokenByIdPrefix(pairingTokens.list(), args[1]);
        if (!resolved.ok) return undefined;
        return {
          title: `Revoke device "${resolved.token.name}"?`,
          detail: `Device ${shortTokenId(resolved.token.id)} ("${resolved.token.name}") stops authenticating at once and has to pair again to get a new token.`,
          confirmLabel: 'Revoke',
        };
      }
      if (!pairingTokens) return undefined;
      if (sub === 'revoke-shared' && (connected !== null || !pairingTokens.isLegacyRevoked())) {
        return {
          title: 'Revoke the shared token?',
          detail: `Every device still using it is signed out and has to pair again for its own token${pairingTokens.list().length === 0
            ? ' (no device has its own token yet)' : ''}. The daemon writes a new shared token for this machine, so this terminal, the Agent and the daemon CLI stay signed in.`,
          confirmLabel: 'Revoke',
        };
      }
      return undefined;
    },
    async handler(args, ctx) {
      if (await runDeviceCapabilitySubcommand(args, ctx.platform.devices, (message) => ctx.print(message))) return;
      const sub = (args[0] ?? 'list').toLowerCase();
      const known = ['list', 'rename', 'revoke', 'migrate-shared', 'revoke-shared'];
      if (!known.includes(sub)) {
        throw commandRefusal(`Unknown /devices subcommand: ${sub}.`, `Use: list | rename | revoke | migrate-shared | revoke-shared | ${DEVICE_CAPABILITY_USAGE}`, 'USAGE');
      }
      const pairingTokens = deviceTokenStore(ctx);
      try {
        await runDeviceTokenSubcommand(sub, args, ctx, pairingTokens);
      } catch (error) {
        if (error instanceof Error && 'refusal' in error) throw error;
        throw commandRefusal(`/devices ${sub} on ${pairingTokens.where} did not finish: ${describeOperatorRpcError(error)}`, '/devices list shows the current devices', 'NOT_DONE');
      }
    },
  });
}

async function runDeviceTokenSubcommand(sub: string, args: string[], ctx: CommandContext, pairingTokens: DeviceTokenStore): Promise<void> {
  if (sub === 'list') {
    await renderList(ctx, pairingTokens);
    return;
  }

  if (sub === 'rename') {
    const idOrPrefix = args[1];
    const name = args.slice(2).join(' ').trim();
    if (!idOrPrefix || !name) throw commandRefusal('Usage: /devices rename <id> <new name>');
    const resolved = resolveTokenByIdPrefix(await pairingTokens.list(), idOrPrefix);
    if (!resolved.ok) throw unresolvedDevice(resolved.reason, idOrPrefix);
    if (!await pairingTokens.rename(resolved.token.id, name)) {
      throw commandRefusal(`No device matches "${idOrPrefix}" any more (it was revoked elsewhere); nothing was renamed.`, '/devices list shows each device id', 'NOT_FOUND');
    }
    ctx.print(`Renamed device to "${name}" on ${pairingTokens.where}.`);
    return;
  }

  if (sub === 'revoke') {
    const idOrPrefix = args[1];
    if (!idOrPrefix) throw commandRefusal('Usage: /devices revoke <id>');
    const resolved = resolveTokenByIdPrefix(await pairingTokens.list(), idOrPrefix);
    if (!resolved.ok) throw unresolvedDevice(resolved.reason, idOrPrefix);
    const revoked = await pairingTokens.revoke(resolved.token.id);
    ctx.print(revoked ? `Revoked "${resolved.token.name}" on ${pairingTokens.where}: its token stops working immediately.` : `Device "${resolved.token.name}" was already absent.`);
    return;
  }

  if (sub === 'migrate-shared') {
    const name = args.slice(1).join(' ').trim() || 'migrated device';
    const minted = await pairingTokens.mintForMigration(name);
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
    if (await pairingTokens.legacyRevoked()) {
      ctx.print('The shared token is already revoked; only this machine holds its replacement.');
      return;
    }
    const revocation = await revokeSharedTokenOnDaemon(getOperatorRpc(ctx));
    if (!revocation.ok) throw commandRefusal(revocation.message, 'Start the daemon and run /devices revoke-shared again', 'NOT_DONE');
    ctx.print(revocation.message);
    return;
  }
}

async function renderList(ctx: CommandContext, pairingTokens: DeviceTokenStore): Promise<void> {
  const list = await pairingTokens.list();
  const lines: string[] = [`Paired devices on ${pairingTokens.where}:`];
  if (list.length === 0) {
    lines.push('  (none yet: pair one with /pair)');
  } else {
    for (const token of list) lines.push(`  ${formatDeviceLine(token)}`);
  }
  lines.push(
    '',
    await pairingTokens.legacyRevoked()
      ? 'Shared token: revoked and replaced; only the apps on this machine hold it.'
      : 'Shared token: active, also held by devices paired before per-device tokens; run /devices migrate-shared then /devices revoke-shared to retire their copies.',
  );
  ctx.print(lines.join('\n'));
}
