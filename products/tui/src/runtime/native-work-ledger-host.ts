import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import { registerWorkCommand } from '@goodvibes/engine/terminal-shell/native/work-command';
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
import { workRequestsHost } from '../input/commands/planning-runtime.ts';
import { capabilityBinding } from '../input/commands/capability-binding.ts';

/** The terminal app's view of its link to the host: the submission journal and the input waiting to be admitted. */
export interface NativeWorkLedgerHost {
  readonly view: NativeWorkLedgerView;
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
): NativeWorkLedgerHost {
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
  const view = createBoundNativeWorkLedgerView(
    resolve,
    // Nothing in this program draws the view: the Work place reads work from the daemon.
    () => {},
    {
      identityFormat: 'credential',
      intake: TUI_NATIVE_INTAKE_POLICY,
    },
    bind,
  );
  return { view };
}

/** `/work` (terminal-shell/native/work-command.ts) in the terminal app: its submission journal, requests in your own words, and the daemon it runs work on. */
export function registerNativeWorkLedgerCommand(registry: CommandRegistry, view: NativeWorkLedgerView): void {
  registerWorkCommand<CommandContext>(registry, {
    view: () => view,
    // The terminal app runs selected diffs; a hosted turn is not resumed here.
    allowHostedDispatch: false,
    requests: workRequestsHost(),
  }, capabilityBinding);
}
