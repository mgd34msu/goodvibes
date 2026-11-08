import { createPaymentWindowCommand } from '@goodvibes-jev/engine/terminal-shell/payment-window-command';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { isDirectOwnerCommandContext, type CommandContext } from '../command-registry.ts';
import { resolveConnectedHostConnection } from '../../runtime/client/daemon-verbs.ts';
import { agentHostPairingStorePath } from '../../runtime/connected-host-pairing-store.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';

/** Keep Agent's selected-host/credential policy; the common controller verifies
 * live paired payment authority before presenting or sending an owner answer. */
export const openPendingPaymentWindows = createPaymentWindowCommand<CommandContext>({
  isOwner: context => isDirectOwnerCommandContext(context, 'payments'),
  owner: context => context.platform.configManager,
  home: context => requireShellPaths(context).homeDirectory,
  read(context, observation) {
    const host = resolveConnectedHostConnection({ configManager: context.platform.configManager,
      homeDirectory: requireShellPaths(context).homeDirectory, observation });
    return 'reason' in host ? null : { baseUrl: host.baseUrl, token: host.token, identity: host.selectionIdentity,
      ...(host.expectedPrincipalId === undefined ? {} : { expectedPrincipalId: host.expectedPrincipalId }) };
  },
  environment: () => [process.env.GOODVIBES_CONNECTED_HOST_TOKEN, process.env.GOODVIBES_DAEMON_TOKEN],
  files(selection, home) {
    if (process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim()) return [];
    const pairing = agentHostPairingStorePath(home);
    return selection.expectedPrincipalId === undefined ? [pairing, connectedHostOperatorTokenPath(home)] : [pairing];
  },
});
