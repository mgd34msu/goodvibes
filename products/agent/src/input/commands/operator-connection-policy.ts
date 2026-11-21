import type { PaymentWindowCommandPolicy } from '@goodvibes/engine/terminal-shell/payment-window-command';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import type { CommandContext } from '../command-registry.ts';
import { resolveConnectedHostConnection } from '../../runtime/client/daemon-verbs.ts';
import { agentHostPairingStorePath } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-pairing-store';
import { connectedHostOperatorTokenPath, environmentConnectedHostToken } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-auth';


/** Product host selection only; interactive owner controllers share this exact policy. */
export const ownerOperatorConnectionPolicy: Omit<PaymentWindowCommandPolicy<CommandContext>, 'isOwner'> = {
  owner: context => context.platform.configManager,
  home: context => requireShellPaths(context).homeDirectory,
  read(context, observation) {
    const host = resolveConnectedHostConnection({ configManager: context.platform.configManager,
      homeDirectory: requireShellPaths(context).homeDirectory, observation });
    return 'reason' in host ? null : { baseUrl: host.baseUrl, token: host.token, identity: host.selectionIdentity,
      ...(host.expectedPrincipalId === undefined ? {} : { expectedPrincipalId: host.expectedPrincipalId }) };
  },
  // A change to either variable can change the credential in effect, so both are watched.
  environment: () => [process.env.GOODVIBES_CONNECTED_HOST_TOKEN, process.env.GOODVIBES_DAEMON_TOKEN],
  files(selection, home) {
    // The same rule the credential was chosen by: this machine's daemon token only for this machine.
    if (environmentConnectedHostToken(selection.baseUrl)) return [];
    const pairing = agentHostPairingStorePath(home);
    return selection.expectedPrincipalId === undefined ? [pairing, connectedHostOperatorTokenPath(home)] : [pairing];
  },
};
