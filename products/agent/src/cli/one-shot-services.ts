/**
 * The services a one-shot CLI command reads, built for that command alone and
 * bound to the Agent's own files. The builders are shared with the TUI
 * (terminal-shell/cli-one-shot-services.ts): no project activation, no home
 * claim and no contract pick-up for a listing.
 */
import { createOneShotServices } from '@goodvibes-jev/engine/terminal-shell/cli-one-shot-services';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

export type {
  OneShotProviderOptions,
  OneShotProviderServices,
  OneShotSessionServices,
} from '@goodvibes-jev/engine/terminal-shell/cli-one-shot-services';

export const { withProviderServices, withSessionServices } = createOneShotServices(GOODVIBES_AGENT_SURFACE_ROOT);
