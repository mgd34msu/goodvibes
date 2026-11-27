import {
  TerminalHostPairingController,
  type HostPairingUi as PairingUi,
} from '@goodvibes/engine/terminal-shell/host-pairing-controller';
import { previewTuiHostPairing, type TuiHostPairingPreview, type TuiHostPairingOptions } from '../runtime/tui-host-pairing.ts';

import { formatTuiHostPairing, REPEAT_LOST_REQUEST } from '../runtime/tui-host-pairing.ts';
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
        command: 'Pair something in Devices and network (This program with its daemon)',
        pairedRecovery: (host) =>
          formatTuiHostPairing({
            status: 'paired-unverified',
            host,
            message:
              'Pairing credential stored for this host. Verification was interrupted; pair it again in Devices and network (Pair something, This program with its daemon). No second credential will be created.',
          }),
        unknownRecovery: (host) =>
          formatTuiHostPairing({
            status: 'unknown',
            host,
            message:
              `The reply to a pairing request was lost. ${REPEAT_LOST_REQUEST} Or run goodvibes host pair --apply in a shell to forget the attempt and pair from scratch.`,
          }),
      },
      ui,
    );
  }
}
