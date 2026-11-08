import { createPaymentWindowCommand } from '@goodvibes-jev/engine/terminal-shell/payment-window-command';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { isDirectOwnerCommandContext, type CommandContext } from '../command-registry.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';

/** TUI selects only its host-bound paired credential; no shared-token fallback. */
export const openPendingPaymentWindows = createPaymentWindowCommand<CommandContext>({
  isOwner: context => isDirectOwnerCommandContext(context, 'payments'),
  owner: context => context.platform.configManager,
  home: context => requireShellPaths(context).homeDirectory,
  read(context, observation) {
    const host = resolveNativeHostCredential({ configManager: context.platform.configManager,
      homeDirectory: requireShellPaths(context).homeDirectory, observation });
    return host.available ? { baseUrl: host.baseUrl, token: host.token, identity: host.identity,
      ...(host.expectedPrincipalId === undefined ? {} : { expectedPrincipalId: host.expectedPrincipalId }) } : null;
  },
  files: (_selection, home) => [tuiHostPairingStorePath(home)],
});
