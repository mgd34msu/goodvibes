import { isDirectOwnerCommandContext, type CommandRegistry } from '../command-registry.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { formatTuiHostPairing, unpairTuiHost } from '../../runtime/tui-host-pairing.ts';
import { requireShellPaths } from './runtime-services.ts';

const USAGE = 'Usage: /host pair [--bootstrap-shared] [--name <device-name>] [--apply] | /host unpair. --yes and inline confirmation are unsupported; apply requires fresh confirmation in the owner terminal.';

/** Generic slash/tool dispatch is local, passive inspection only. The private
 * direct-owner route may begin the shell's cancellable pairing lifetime.
 */
export function registerHostPairingCommands(registry: CommandRegistry): void {
  registry.register({ name: 'host', description: 'Inspect, pair or unpair this TUI with its selected host in the owner terminal',
    async handler(args, context) {
      if (args[0] === 'unpair' && args.length === 1) {
        // Forgetting the credential cuts this terminal off from its host until the owner pairs again, so only the owner's own keyboard may do it.
        if (!isDirectOwnerCommandContext(context, 'host')) { context.print('/host unpair forgets this terminal\'s host credential, so only the owner can run it by typing /host unpair in the terminal. Nothing was forgotten.'); return; }
        try {
          const paths = requireShellPaths(context);
          context.print(formatTuiHostPairing(await unpairTuiHost({ configManager: context.platform.configManager, homeDirectory: paths.homeDirectory })));
        } catch { context.print('TUI host credentials are unavailable here. Use goodvibes host unpair in an owner terminal.'); }
        return;
      }
      if (args[0] !== 'pair') { context.print(USAGE); return; }
      let apply = false; let bootstrapShared = false; let named = false; let name = 'GoodVibes TUI';
      for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply' && !apply) { apply = true; continue; }
        if (arg === '--bootstrap-shared' && !bootstrapShared) { bootstrapShared = true; continue; }
        if (arg === '--name' && !named && args[index + 1] && !args[index + 1]!.startsWith('--') && !/\s/.test(args[index + 1]!)) {
          named = true; name = args[++index]!; continue;
        }
        context.print(USAGE); return;
      }
      if (isDirectOwnerCommandContext(context, 'host') && context.beginHostPairing) {
        await context.beginHostPairing({ apply, bootstrapShared, name }); return;
      }
      if (apply) {
        context.print('Pairing --apply requires the owner to type /host pair --bootstrap-shared --apply in the live owner terminal. Model, harness and nested commands cannot grant persistent administrative access.');
        return;
      }
      try {
        const paths = requireShellPaths(context);
        const credential = resolveNativeHostCredential({ configManager: context.platform.configManager, homeDirectory: paths.homeDirectory });
        context.print(!credential.available ? credential.reason
          : credential.expectedPrincipalId
            ? `TUI credential saved for ${credential.baseUrl}. Live scopes and native authority are checked by each operation.`
            : `No device pairing is saved for ${credential.baseUrl}; it is the daemon on this machine, so the operator token this terminal already holds is used and no pairing is needed. Live scopes and native authority are checked by each operation.`);
        context.print('Local inspection only. For explicit pairing, type /host pair --bootstrap-shared in the live owner terminal, then add --apply to review and confirm. Existing /pair remains companion/WebUI pairing.');
      } catch { context.print('TUI host credentials are unavailable here. Use goodvibes host pair in an owner terminal.'); }
    },
  });
}
