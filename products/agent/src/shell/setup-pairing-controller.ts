import {
  TerminalHostPairingController,
  type HostPairingUi as PairingUi,
} from '@goodvibes/engine/terminal-shell/host-pairing-controller';
import { previewAgentHostPairing, type AgentHostPairingPreview } from '../runtime/agent-host-pairing.ts';
import type { AgentDaemonVerbCallerOptions } from '../runtime/client/daemon-verbs.ts';
import { formatSetupPairing } from '../runtime/setup-pairing-presentation.ts';

import { readAgentHostPairing } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-pairing-store';
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
              'This Agent kept its new key for this host, but checking it was interrupted. Run goodvibes-agent setup status in a shell to check it; pairing again is not needed and would not make a second key.',
          }),
        unknownRecovery: (host) =>
          formatSetupPairing({
            status: 'unknown',
            host,
            message:
              'The host\'s answer to the pairing request was lost. Run /setup pair to repeat the same request: the host answers it with the key it made, never a second one; if that cannot be done, /setup pair offers to forget the attempt and pair from scratch.',
          }),
      },
      ui,
    );
  }
}
