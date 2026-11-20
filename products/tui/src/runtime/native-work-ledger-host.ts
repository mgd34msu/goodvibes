import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import { registerWorkCommand } from '@goodvibes/engine/terminal-shell/native/work-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import {
  createBoundNativeWorkLedgerView,
  type NativeLedgerBindingFactory,
  type NativeLedgerHost,
} from '@goodvibes/engine/terminal-shell/native/bound-work-ledger-host';
import type { NativeWorkLedgerView } from '@goodvibes/engine/terminal-shell/native/work-ledger-view';
import { TUI_NATIVE_INTAKE_POLICY } from '@goodvibes/engine/terminal-shell/native-intake';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { resolveNativeHostCredential } from './client/native-host-credential.ts';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { openTuiLegacyImport } from '../input/commands/legacy-work-ledger-import-runtime.ts';
import { workRequestsHost } from '../input/commands/planning-runtime.ts';

/** What the /work modal reads: the shared view and one change listener at a time. */
export interface NativeWorkLedgerModalSource {
  readonly view: NativeWorkLedgerView;
  /** Route view changes to `listener` until the returned function is called. */
  watch(listener: () => void): () => void;
}

/**
 * The TUI's /work host: the shared selection owner with the TUI's differences,
 * its credential (a device pairing, or on the daemon's own machine the operator
 * token it already holds) and its intake policy (selected diffs, no hosted turns).
 */
export function createNativeWorkLedgerHost(
  deps: {
    readonly configManager: ConfigManager;
    readonly homeDirectory: string | (() => string);
    readonly daemonHomeDirectory?: string;
    readonly journalPath?: string;
    readonly workspace: () => string;
  },
  bind?: NativeLedgerBindingFactory,
): NativeWorkLedgerModalSource {
  const observation = new OwnedSelectionObservation();
  const homeDirectory = () => (typeof deps.homeDirectory === 'function' ? deps.homeDirectory() : deps.homeDirectory);
  const resolve = (): NativeLedgerHost => {
    const credential = resolveNativeHostCredential({ configManager: deps.configManager, homeDirectory: homeDirectory(), observation });
    if (!credential.available) return { reason: credential.reason };
    return {
      baseUrl: credential.baseUrl,
      token: credential.token,
      credentialIdentity: credential.identity,
      ...(credential.expectedPrincipalId ? { expectedPrincipalId: credential.expectedPrincipalId } : {}),
      workspace: deps.workspace(),
      journalPath: deps.journalPath,
    };
  };
  let listener: () => void = () => {};
  const view = createBoundNativeWorkLedgerView(
    resolve,
    () => listener(),
    {
      identityFormat: 'credential',
      intake: TUI_NATIVE_INTAKE_POLICY,
    },
    bind,
  );
  return {
    view,
    watch(next) {
      listener = next;
      return () => {
        if (listener === next) listener = () => {};
      };
    },
  };
}

/** `/work` (terminal-shell/native/work-command.ts) in the terminal app: its work view, its host's imports, and requests in your own words. */
export function registerNativeWorkLedgerCommand(registry: CommandRegistry, view: NativeWorkLedgerView): void {
  registerWorkCommand<CommandContext>(registry, {
    view: () => view,
    open(ctx, project) {
      if (project) view.selectProject(project);
      if (!ctx.openModal) throw commandRefusal('The native work view is not available in this shell.');
      ctx.openModal('native-work-ledger-modal');
    },
    // The terminal app runs selected diffs; a hosted turn is not resumed here.
    allowHostedDispatch: false,
    openImport: openTuiLegacyImport,
    requests: workRequestsHost(),
  });
}
