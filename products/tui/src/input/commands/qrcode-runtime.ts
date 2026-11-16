import type { CommandRegistry } from '../command-registry.ts';
import { openModalCommand } from './runtime-services.ts';

/**
 * Register the /qrcode command.
 *
 * `/qrcode` (no args, aliases /qr /pair) opens the device-pairing modal: a QR of
 * the `#pair=<token>` deep link plus the offer set. The token is an offer: no
 * device is added until one uses it, and reopening shows the same offer while
 * it is unused and unexpired. `r` in the modal shows a new one in its place; the
 * one it replaces stops working unless a device already paired with it.
 */
export function registerQrcodeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'qrcode',
    aliases: ['qr', 'pair'],
    description: 'Open the device-pairing modal (QR deep link + offers); press r in it for a new device token',
    usage: '[regenerate]',
    argsHint: '[regenerate]',
    handler(args, ctx) {
      if (args[0]?.toLowerCase() === 'regenerate') {
        ctx.print('Opening the pairing QR. Press r in it for a new device token; the one it replaces stops working unless a device already paired with it.');
        openModalCommand(ctx, 'pairing-modal');
        return;
      }
      openModalCommand(ctx, 'pairing-modal');
    },
  });
}
