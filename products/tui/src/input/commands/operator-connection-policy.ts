import type { PaymentWindowCommandPolicy } from '@goodvibes-jev/engine/terminal-shell/payment-window-command';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import type { CommandContext } from '../command-registry.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';


/** Product host selection only; interactive owner controllers share this exact policy. */
export const ownerOperatorConnectionPolicy: Omit<PaymentWindowCommandPolicy<CommandContext>, 'isOwner'> = {
  owner: context => context.platform.configManager,
  home: context => requireShellPaths(context).homeDirectory,
  read(context, observation) {
    const host = resolveNativeHostCredential({ configManager: context.platform.configManager,
      homeDirectory: requireShellPaths(context).homeDirectory, observation });
    return host.available ? { baseUrl: host.baseUrl, token: host.token, identity: host.identity,
      ...(host.expectedPrincipalId === undefined ? {} : { expectedPrincipalId: host.expectedPrincipalId }) } : null;
  },
  files: (_selection, home) => [tuiHostPairingStorePath(home)],
};
