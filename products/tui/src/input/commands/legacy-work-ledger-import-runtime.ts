import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client/selection-observation';
import { createOperatorApiClient } from '@goodvibes-jev/engine/operator-client';
import { createNativeHostFetch } from '@goodvibes-jev/engine/terminal-shell/native';
import { realpathSync } from 'node:fs';
import { openLegacyImportOperator, resolveLegacyImportJournalLocation, retainLegacyImportJournalOwner, type LegacyImportOperatorSession } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import type { CommandContext } from '../command-registry.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
export type OpenTuiLegacyImportSession = (context: CommandContext, projectId: string) => Promise<LegacyImportOperatorSession>;
/** An import session for `/work import…` (terminal-shell/native/work-command.ts) on this terminal's host. */
export const openTuiLegacyImport: OpenTuiLegacyImportSession = async (context, projectId) => {
  const credentialObservation = new OwnedSelectionObservation();
  const paths = requireShellPaths(context);
  // A device pairing, or on the daemon's own machine the operator token this terminal already holds.
  const chosen = resolveNativeHostCredential({ configManager: context.platform.configManager, homeDirectory: paths.homeDirectory, observation: credentialObservation });
  if (!chosen.available) throw new Error(chosen.reason);
  const workspace = realpathSync(paths.workingDirectory);
  const configOwner = context.platform.configManager, stateDirectory = paths.resolveUserPath();
  const location = resolveLegacyImportJournalLocation({ workspace, projectId, stateDirectory });
  // Keep the engine import session bound to the private store generation as
  // well as endpoint/token/workspace, including replacement with the same token.
  return openLegacyImportOperator({ projectId, journalPath: location.journalPath, journalOptions: retainLegacyImportJournalOwner(location, configOwner, stateDirectory, () => ({ config: context.platform.configManager, stateDirectory: requireShellPaths(context).resolveUserPath() })),
    createClient(host) {
      let disposed = false;
      const client = createOperatorApiClient({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current: () => {
        if (disposed) return false;
        const paths = requireShellPaths(context);
        const credential = resolveNativeHostCredential({ configManager: context.platform.configManager, homeDirectory: paths.homeDirectory, observation: credentialObservation });
        return credential.available && credential.identity === chosen.identity && realpathSync(paths.workingDirectory) === workspace;
      } }) });
      return { currentAuth: signal => client.control.auth.current({}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }),
        invoke: (method, input, signal) => client.invoke(method, input, { signal }), dispose: () => { disposed = true; client.dispose(); } };
    },
    resolve: () => {
      const current = requireShellPaths(context);
      const credential = resolveNativeHostCredential({ configManager: context.platform.configManager, homeDirectory: current.homeDirectory, observation: credentialObservation });
      if (!credential.available) return { reason: credential.reason };
      if (credential.identity !== chosen.identity || realpathSync(current.workingDirectory) !== workspace) return { reason: 'Selected TUI host credentials changed' };
      return { baseUrl: credential.baseUrl, token: credential.token, workspace };
    },
  });
};
