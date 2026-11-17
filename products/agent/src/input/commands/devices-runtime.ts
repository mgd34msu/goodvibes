import type { CommandRegistry } from '../command-registry.ts';
import {
  DEVICE_CAPABILITY_SUBCOMMANDS,
  DEVICE_CAPABILITY_USAGE,
  deviceCapabilityConfirmation,
  runDeviceCapabilitySubcommand,
} from '@goodvibes-jev/engine/terminal-shell/device-capabilities-command';
import { commandRefusal, stripYesFlag } from './confirmation.ts';

/**
 * Register /devices: the phones paired with the daemon as device nodes, the
 * "always allow" grants with revoke, and the captures the daemon is keeping
 * with delete. The same lines as the terminal app's /devices; revoking a grant
 * and deleting a capture ask once (the registry's confirmation), and `--yes`
 * typed by the owner answers in advance.
 */
export function registerDevicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'devices',
    effect: 'connected-host-state',
    aliases: ['device'],
    description: 'Paired phones: the device nodes, always-allow grants (revoke) and retained captures (delete)',
    usage: `[${DEVICE_CAPABILITY_USAGE}]`,
    argsHint: '[nodes|grants|revoke-grant|captures|delete-capture]',
    subcommands: DEVICE_CAPABILITY_SUBCOMMANDS,
    confirm: (args) => deviceCapabilityConfirmation(args.length ? args : ['nodes']),
    async handler(args, ctx) {
      const { rest } = stripYesFlag(args);
      const line = rest.length ? rest : ['nodes'];
      if (await runDeviceCapabilitySubcommand(line, ctx.platform.devices, (message) => ctx.print(message))) return;
      throw commandRefusal(`Unknown /devices subcommand: ${line[0]}. Use: ${DEVICE_CAPABILITY_USAGE}`);
    },
  });
}
