import { OwnedSelectionObservation } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { realpathSync } from 'node:fs';
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { openLegacyImportOperator, registerLegacyImportCommands, resolveLegacyImportJournalLocation, retainLegacyImportJournalOwner, type LegacyImportOperatorSession } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { connectedHostBaseUrl } from '../../config/connected-host-dial.ts';
import { canonicalizePairingHost, readAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { requireShellPaths } from './runtime-services.ts';
export type OpenLegacyImportCommandSession = (context: CommandContext, projectId: string) => Promise<LegacyImportOperatorSession>;
export function registerLegacyWorkLedgerImportCommands(registry: CommandRegistry, open: OpenLegacyImportCommandSession = async (context, projectId) => {
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
      if (pairing.status !== 'paired') return unavailable(pairing.status === 'unknown'
        ? 'The selected Agent host pairing outcome is unknown; inspect it before importing.'
        : 'An existing private Agent pairing for this exact host is required. Use /setup pair to inspect pairing.');
      // Passive private state only: neither an unbound environment token nor a
      // daemon-global credential can mask or replace this selected native owner.
      return { baseUrl, token: pairing.token, workspace: realpathSync(current.workingDirectory),
        selectionIdentity: selection.observe([current.homeDirectory, baseUrl, pairing], config) };
    } catch (error) { selection.retire(); throw error; }
  } });
}): void { registerLegacyImportCommands(registry, open); }
