import type { CommandRegistry } from '../command-registry.ts';
import { requirePeerClient } from './runtime-services.ts';
import { handleRemoteSessionCommand } from './remote-runtime-setup.ts';

/** `/teleport` is `/remote session` under its older name: one handler, one printer. */
export function registerTeleportRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'teleport',
    description: 'Export, inspect or import a remote session bundle (runner pools, contracts, artifacts); the same as /remote session',
    usage: '<export|inspect|import> <path> [--yes]',
    async handler(args, ctx) {
      let peerClient;
      try {
        peerClient = requirePeerClient(ctx);
      } catch {
        ctx.print('Remote runner registry is not available in this runtime.');
        return;
      }
      await handleRemoteSessionCommand(args, ctx, peerClient.runners, '/teleport');
    },
  });
}
