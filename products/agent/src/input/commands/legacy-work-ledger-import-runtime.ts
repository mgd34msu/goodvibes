import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client/selection-observation';
import { realpathSync } from 'node:fs';
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { openLegacyImportOperator, resolveLegacyImportJournalLocation, retainLegacyImportJournalOwner, type LegacyImportOperatorSession } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import type { CommandContext } from '../command-registry.ts';
import { connectedHostBaseUrl } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-dial';
import { canonicalizePairingHost, readAgentHostPairing } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-pairing-store';
import { readConnectedHostOperatorToken } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-auth';
import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/utils/reachable-base-url';
import { requireShellPaths } from './runtime-services.ts';
export type OpenLegacyImportCommandSession = (context: CommandContext, projectId: string) => Promise<LegacyImportOperatorSession>;
/** An import session for `/work import…` (terminal-shell/native/work-command.ts) on the connected host. */
export const openAgentLegacyImport: OpenLegacyImportCommandSession = async (context, projectId) => {
  const paths = requireShellPaths(context);
  const configOwner = context.platform.configManager, stateDirectory = paths.resolveUserPath();
  const location = resolveLegacyImportJournalLocation({ workspace: paths.workingDirectory, projectId, stateDirectory });
  const selection = new OwnedSelectionObservation();
  const unavailable = (reason: string) => { selection.retire(); return { reason }; };
  return openLegacyImportOperator({ projectId, journalPath: location.journalPath, journalOptions: retainLegacyImportJournalOwner(location, configOwner, stateDirectory, () => ({ config: context.platform.configManager, stateDirectory: requireShellPaths(context).resolveUserPath() })), resolve: () => {
    try {
      const current = requireShellPaths(context), config = context.platform.configManager;
      if (!resolveConnectedHostDialEnabled(config)) return unavailable('Connected-host dialing is disabled.');
      const baseUrl = canonicalizePairingHost(connectedHostBaseUrl(config.get('controlPlane.host'), config.get('controlPlane.port')));
      if (!baseUrl) return unavailable('Select an exact HTTP(S) daemon origin.');
      const pairing = readAgentHostPairing(current.homeDirectory, baseUrl);
      if (pairing.status === 'missing' && isLoopbackHost(new URL(baseUrl).hostname)) {
        // The daemon on this machine: the operator token file this Agent already
        // holds is the owner's credential there, so no pairing is needed. An
        // environment token is not taken in its place.
        const local = readConnectedHostOperatorToken(current.homeDirectory);
        if (local.source !== 'operator-file' || !local.token) return unavailable('The daemon on this machine is selected, but its operator token file could not be read. Start the daemon once, or pair this Agent with /setup pair.');
        return { baseUrl, token: local.token, workspace: realpathSync(current.workingDirectory),
          selectionIdentity: selection.observe([current.homeDirectory, baseUrl, pairing, local.token], config) };
      }
      if (pairing.status !== 'paired') return unavailable(pairing.status === 'unknown'
        ? 'The selected Agent host pairing outcome is unknown; inspect it before importing.'
        : 'An existing private Agent pairing for this exact host is required for a daemon on another machine. Use /setup pair to inspect pairing.');
      // Passive private state only: neither an unbound environment token nor a
      // daemon-global credential can mask or replace this selected native owner.
      return { baseUrl, token: pairing.token, workspace: realpathSync(current.workingDirectory),
        selectionIdentity: selection.observe([current.homeDirectory, baseUrl, pairing], config) };
    } catch (error) { selection.retire(); throw error; }
  } });
};
