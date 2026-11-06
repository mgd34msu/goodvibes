import {
  TerminalHostPairingController,
  type HostPairingUi as PairingUi,
} from '@goodvibes-jev/engine/terminal-shell/host-pairing-controller';
import { previewAgentHostPairing, type AgentHostPairingPreview } from '../runtime/agent-host-pairing.ts';
import type { AgentDaemonVerbCallerOptions } from '../runtime/client/daemon-verbs.ts';
import { formatSetupPairing } from '../runtime/setup-pairing-presentation.ts';

import { readAgentHostPairing } from '../runtime/connected-host-pairing-store.ts';
export type SetupPairingUi = PairingUi;
type PairingRequest = { readonly apply: boolean; readonly name: string };
export class SetupPairingController extends TerminalHostPairingController<PairingRequest, AgentHostPairingPreview['result']> {
  constructor(options: AgentDaemonVerbCallerOptions, ui: SetupPairingUi) {
    super(
      {
        home: () => (typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory),
        preview: (request, signal) => previewAgentHostPairing(options, request.name, signal),

        format: formatSetupPairing,
        readRecovery: readAgentHostPairing,
        command: '/setup pair',
        pairedRecovery: (host) =>
          formatSetupPairing({
            status: 'paired-unverified',
            host,
            message:
              'Pairing credential stored for this host. Verification was interrupted; rerun setup status. No second credential will be created.',
          }),
        unknownRecovery: (host) =>
          formatSetupPairing({
            status: 'unknown',
            host,
            message:
              'A pairing attempt may already have created a credential. Inspect its outcome on this host; no automatic remint or revoke is allowed.',
          }),
      },
      ui,
    );
  }
}
