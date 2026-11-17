import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client/selection-observation';
import { handleNativeIntakeCommand, handleNativeSubmissionCommand } from '@goodvibes-jev/engine/terminal-shell/native/work-command';
import {
  createBoundNativeWorkLedgerView,
  type NativeLedgerBindingFactory,
  type NativeLedgerHost,
} from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger-host';
import type { NativeWorkLedgerView } from '@goodvibes-jev/engine/terminal-shell/native/work-ledger-view';
import { TUI_NATIVE_INTAKE_POLICY } from '@goodvibes-jev/engine/terminal-shell/native-intake';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveNativeHostCredential } from './client/native-host-credential.ts';
import type { CommandRegistry } from '../input/command-registry.ts';

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

export function registerNativeWorkLedgerCommand(registry: CommandRegistry, view: NativeWorkLedgerView): void {
  const submitFile = view.submitFile, submissionStatus = view.submissionStatus, retrySubmission = view.retrySubmission,
    discardSubmission = view.discardSubmission;
  const submission =
    submitFile && submissionStatus && retrySubmission && discardSubmission
      ? {
          submitFile: (path: string) => submitFile.call(view, path),
          status: () => submissionStatus.call(view),
          retry: () => retrySubmission.call(view),
          discard: () => discardSubmission.call(view),
        }
      : undefined;
  registry.register({
    name: 'work',
    description:
      'Inspect native work, submit source with submit-file <JSON-path> and settle it with submission-status/submission-retry/submission-discard, and recover ordinary input with intake-status/intake-retry/intake-resume/intake-cancel; /work <daemon-project-id> selects a project.',
    handler: async (args, ctx) => {
      if (await handleNativeIntakeCommand(args, ctx, false)) return;
      if (await handleNativeSubmissionCommand(args, (text) => ctx.print(text), submission)) return;
      if (args.length > 1) {
        ctx.print('Usage: /work [exact-daemon-project-id]');
        return;
      }
      if (args[0]) view.selectProject(args[0]);
      if (!ctx.openModal) {
        ctx.print('Native work view is unavailable in this shell.');
        return;
      }
      ctx.openModal('native-work-ledger-modal');
    },
  });
}
