import {
  TerminalHostPairingController,
  type HostPairingUi as PairingUi,
} from '@goodvibes-jev/engine/terminal-shell/host-pairing-controller';
import { previewTuiHostPairing, type TuiHostPairingPreview, type TuiHostPairingOptions } from '../runtime/tui-host-pairing.ts';

import { formatTuiHostPairing } from '../runtime/tui-host-pairing.ts';
import { readTuiHostPairing } from '../runtime/tui-host-credential-store.ts';
export type HostPairingUi = PairingUi;
type PairingRequest = { readonly apply: boolean; readonly name: string; readonly bootstrapShared: boolean };
export class HostPairingController extends TerminalHostPairingController<PairingRequest, TuiHostPairingPreview['result']> {
  constructor(options: TuiHostPairingOptions, ui: HostPairingUi) {
    super(
      {
        home: () => (typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory),
        preview: (request, signal) => previewTuiHostPairing({ ...options, bootstrapShared: request.bootstrapShared }, request.name, signal),
        beforePreview(request, ui) {
          if (request.bootstrapShared)
            ui.print(
              'Explicit bootstrap: the existing daemon-global operator token will authenticate only to the selected host for this migration preview. Native work never uses it as a fallback. No secret is printed or copied.',
            );
        },
        format: formatTuiHostPairing,
        readRecovery: readTuiHostPairing,
        command: '/host pair',
        pairedRecovery: (host) =>
          formatTuiHostPairing({
            status: 'paired-unverified',
            host,
            message:
              'Pairing credential stored for this host. Verification was interrupted; rerun /host pair. No second credential will be created.',
          }),
        unknownRecovery: (host) =>
          formatTuiHostPairing({
            status: 'unknown',
            host,
            message:
              'A pairing attempt may already have created a credential. Inspect its outcome on this host; no automatic remint, reset or revoke is allowed.',
          }),
      },
      ui,
    );
  }
}
