/**
 * The services a one-shot CLI command reads, built for that command alone and
 * bound to the TUI's own files. The builders are shared with the Agent
 * (terminal-shell/cli-one-shot-services.ts): a listing typed in any folder
 * activates no project there, claims no home and takes up no contract.
 */
import { createOneShotServices } from '@goodvibes/engine/terminal-shell/cli-one-shot-services';
import { GOODVIBES_TUI_SURFACE_ROOT, TUI_TRUSTS_SAVED_SCANNED_SERVERS } from '../config/surface.ts';

export type {
  OneShotProviderOptions,
  OneShotProviderServices,
  OneShotSessionServices,
} from '@goodvibes/engine/terminal-shell/cli-one-shot-services';

export const { withProviderServices, withSessionServices } = createOneShotServices(GOODVIBES_TUI_SURFACE_ROOT, {
  trustScannedServer: TUI_TRUSTS_SAVED_SCANNED_SERVERS,
});
