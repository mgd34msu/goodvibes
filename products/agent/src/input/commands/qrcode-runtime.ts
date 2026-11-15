import type { CommandRegistry } from '../command-registry.ts';
import { mintAgentDevicePairing } from '../../agent/device-pairing.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requirePlatform, requireShellPaths } from './runtime-services.ts';

/**
 * `/qrcode` (aliases `/qr`, `/pair`): pair a device with the connected host.
 * Each run mints a new named device token on the host and shows its `#pair=`
 * link and QR, the same pairing the TUI does; the device appears in the host's
 * device list and is revoked there on its own.
 */
export function registerQrcodeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'qrcode',
    aliases: ['qr', 'pair'],
    description: 'Pair a device with the connected host: mints a named device token and shows its link and QR',
    hidden: true,
    usage: '[--name <device name>]',
    argsHint: '[--name <device name>]',
    async handler(args, ctx) {
      // Minting a device token grants a new device access to the host.
      if (ctx.invokedByModel === true) {
        ctx.print('Refused: /pair gives a new device access to the connected host, so it only counts when you type it yourself. Nothing was minted.');
        return;
      }
      const nameIndex = args.indexOf('--name');
      const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
      const verbs = createAgentDaemonVerbCaller({
        configManager: requirePlatform(ctx).configManager,
        homeDirectory: requireShellPaths(ctx).homeDirectory,
      });
      const outcome = await mintAgentDevicePairing(verbs, name === undefined ? {} : { name });
      ctx.print(outcome.ok ? outcome.text : `${outcome.error}\n  next ${outcome.next}`);
    },
  });
}
