import type { GatePresetName } from '@goodvibes/engine/platform/platform/gate/presets';
import { createNativeHostFetch } from './native-host-fetch.js';
import { inProjectFolder } from './native-project-folder.js';
import { NativeConversationIntakePreflight } from './native-conversation-intake-preflight.js';
import { NativeConversationIntakeControls, type NativeConversationIntakePolicy, type NativeConversationIntakeState } from './native-conversation-intake.js';
import { NativeConversationIntakeJournal } from './native-conversation-intake-journal.js';
import { createNativeConversationIntakeBinding } from './native-conversation-intake-host.js';
import { NativeWorkSubmissionPreflight } from './native-work-submission-preflight.js';
import { realpathSync } from 'node:fs';
import { NativeWorkSubmissionJournal } from './native-work-submission-journal.js';
import { intakeJournalPathFor } from './native-journal-paths.js';
import { NativeWorkSubmissionControls, type NativeWorkSubmissionBinding } from './native-work-submission.js';
import { createNativeWorkSubmissionBinding, createNativeSubmissionIdentity, type NativeHostIdentityFormat, type NativeSubmissionHost } from './native-work-submission-host.js';
import { NativeWorkSourceError, readNativeWorkSourceFile } from './native-work-submission-source.js';
import { createOperatorApiClient } from '@goodvibes/engine/operator-client';

import { getOperatorWorkLedgerProject } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client';
import type { NativeWorkLedgerView } from './work-ledger-view.js';

// This program's link to the daemon for work you ask for and messages you type: the daemon's project, found by
// asking the daemon, and the journals that keep what was sent until the daemon answers. The terminal's own view of
// the work ledger (and its reader and run controls) was removed: the Work place reads work from the daemon.

export type NativeLedgerHost = (NativeSubmissionHost & { readonly readExecutionMode?: () => GatePresetName }) | { readonly reason: string };
type BoundHost = Exclude<NativeLedgerHost, { reason: string }>;

/** Asks the host which project it serves; `holds` is asked again before each request leaves. */
export async function discoverNativeLedgerProject(host: BoundHost, signal: AbortSignal, holds: () => boolean = () => true): Promise<string> {
  const current = () => !signal.aborted && holds();
  const operator = createOperatorApiClient({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current }) });
  try {
    // The project of this program's folder, whatever folder the daemon runs in.
    return await getOperatorWorkLedgerProject({ invoke: inProjectFolder(operator.invoke.bind(operator), host.workspace) }, { signal });
  } finally {
    operator.dispose();
  }
}

/**
 * Where the project selection of one terminal stands. A project chosen while no
 * host is available waits in `unavailable` and is applied when the host appears.
 */
export type NativeLedgerHostState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'discovering'; readonly host: BoundHost; readonly controller: AbortController; readonly done: Promise<void> }
  | { readonly kind: 'selected'; readonly host: BoundHost; readonly project: string }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly project?: string | undefined };

/** What differs between the terminal apps; everything else is one implementation. */
export interface NativeLedgerHostPolicy {
  readonly identityFormat: NativeHostIdentityFormat;
  readonly intake: NativeConversationIntakePolicy;
}

const SELECTION_MOVED = 'The daemon, its sign-in or this folder changed while it was in use; the daemon\'s project is found again at the next request.';

/**
 * The one host and project selection owner of a terminal app. The submission
 * controls and the intake controls read the selection from here; `revision`
 * moves on every change of it, and an action compares that integer before it
 * hands its result back.
 */
export function createBoundNativeWorkLedgerView(
  resolve: () => NativeLedgerHost,
  policy: NativeLedgerHostPolicy,
  discover: typeof discoverNativeLedgerProject = discoverNativeLedgerProject,
  bindSubmission: (host: BoundHost, project: string, current: () => boolean) => NativeWorkSubmissionBinding = createNativeWorkSubmissionBinding,
): NativeWorkLedgerView {
  const identityOwner = createNativeSubmissionIdentity(policy.identityFormat);
  const nativeIdentity = identityOwner.identify;
  let state: NativeLedgerHostState = { kind: 'closed' };
  let revision = 0;
  const same = (a: BoundHost, b: BoundHost) =>
    a.baseUrl === b.baseUrl &&
    a.token === b.token &&
    a.workspace === b.workspace &&
    a.journalPath === b.journalPath &&
    a.selectionIdentity === b.selectionIdentity &&
    a.expectedPrincipalId === b.expectedPrincipalId &&
    (policy.identityFormat !== 'credential' || a.credentialIdentity === b.credentialIdentity);
  const selection = (): Extract<NativeLedgerHostState, { kind: 'selected' }> | undefined => (state.kind === 'selected' ? state : undefined);
  const holds = (host: BoundHost, project: string, at: number): boolean => {
    if (at !== revision || state.kind !== 'selected' || state.project !== project || !same(host, state.host)) return false;
    const now = resolve();
    return !('reason' in now) && same(host, now);
  };
  const to = (next: NativeLedgerHostState) => {
    const prior = state;
    state = next;
    revision++;
    if (prior.kind === 'discovering' && prior !== next) prior.controller.abort();
    if (prior.kind === 'selected' || (prior.kind === 'discovering' && next.kind !== 'selected')) {
      submission.close();
      intake.close();
    }
  };
  const sync = () => {
    if (state.kind !== 'discovering' && state.kind !== 'selected') return;
    const host = resolve();
    if ('reason' in host) to({ kind: 'unavailable', reason: host.reason });
    else if (!same(host, state.host)) to({ kind: 'unavailable', reason: SELECTION_MOVED });
  };
  const startDiscovery = (host: BoundHost) => {
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() =>
        discover(host, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), () => {
          const now = resolve();
          return !('reason' in now) && same(now, host);
        }),
      )
      .then(
        (project) => {
          if (state !== discovering) return;
          const current = resolve();
          to('reason' in current || !same(current, host)
            ? { kind: 'unavailable', reason: 'The daemon changed while its project was being found; it is found again at the next request.' }
            : { kind: 'selected', host, project });
        },
        (error) => {
          if (state !== discovering) return;
          const reason = error instanceof Error ? error.message : String(error);
          to({
            kind: 'unavailable',
            reason: `The daemon at ${host.baseUrl} did not say which project it serves: ${reason.split(host.token).join('[redacted]')}. This program needs the daemon's own sign-in, or a pairing that may read your work.`,
          });
        },
      );
    const discovering: NativeLedgerHostState = { kind: 'discovering', host, controller, done };
    to(discovering);
  };
  /** The selected project, discovering it when none is selected. */
  const ensure = async (): Promise<Extract<NativeLedgerHostState, { kind: 'selected' }> | { readonly reason: string }> => {
    for (;;) {
      sync();
      const now = state;
      if (now.kind === 'selected') return now;
      if (now.kind === 'discovering') {
        await now.done;
        if (state.kind === 'unavailable') return state;
        if (state.kind === 'closed') return { reason: 'This program\'s link to the daemon for work is closed.' };
        continue;
      }
      const host = resolve();
      const project = now.kind === 'unavailable' ? now.project : undefined;
      if ('reason' in host) {
        if (state.kind !== 'unavailable' || state.reason !== host.reason) to({ kind: 'unavailable', reason: host.reason, project });
        return host;
      }
      if (project) to({ kind: 'selected', host, project });
      else startDiscovery(host);
    }
  };
  /** Runs an action against the selection; its result is kept only if the selection did not move meanwhile. */
  const withSelection = async <Result extends { status: string }>(
    action: () => Promise<Result | undefined>,
    current: () => boolean,
  ): Promise<Result | { status: 'unavailable'; message: string } | undefined> => {
    const selected = await ensure();
    if (!current()) return undefined;
    if ('reason' in selected) return { status: 'unavailable', message: selected.reason };
    const at = revision;
    const result = await action();
    sync();
    return at === revision ? result : undefined;
  };
  const submission = new NativeWorkSubmissionControls(() => {
    const host = resolve();
    if ('reason' in host) return { available: false, identity: 'unavailable', reason: host.reason };
    const selected = selection();
    const identity = nativeIdentity(host, selected?.project ?? '');
    if (!host.journalPath) return { available: false, identity, reason: 'Native submission journal location is unavailable in this shell.' };
    if (!selected || !same(host, selected.host)) return { available: false, identity, reason: 'Select the native daemon project before submitting source.' };
    const projectId = selected.project;
    const at = revision;
    return {
      available: true,
      identity,
      endpoint: host.baseUrl,
      projectId,
      workspace: realpathSync(host.workspace),
      journal: new NativeWorkSubmissionJournal(host.journalPath),
      bind: () => bindSubmission(host, projectId, () => holds(host, projectId, at) && nativeIdentity(host, projectId) === identity),
    };
  });
  const intake = new NativeConversationIntakeControls(
    () => {
      const host = resolve();
      if ('reason' in host) return { available: false, identity: 'unavailable', reason: host.reason };
      const selected = selection();
      const identity = nativeIdentity(host, selected?.project ?? '');
      if (!host.journalPath || !selected || !same(host, selected.host))
        return { available: false, identity, reason: 'Native conversation intake requires its durable journal and selected daemon project.' };
      const projectId = selected.project;
      // An admitted turn's permit outlives the view, never a new selection.
      const at = revision;
      const workspace = realpathSync(host.workspace);
      return {
        available: true,
        identity,
        endpoint: host.baseUrl,
        projectId,
        workspace,
        journal: new NativeConversationIntakeJournal(intakeJournalPathFor(host.journalPath), {}, policy.intake),
        bind: () =>
          createNativeConversationIntakeBinding(
            host,
            projectId,
            () => {
              let current = false;
              try {
                current = holds(host, projectId, at) && realpathSync(host.workspace) === workspace;
              } catch { /* A missing or replaced workspace retires the selection. */ }
              if (!current && at === revision) queueMicrotask(() => {
                if (at === revision) to({ kind: 'unavailable', reason: SELECTION_MOVED });
              });
              return current;
            },
            { allowHosted: policy.intake.allowHosted, ...(host.readExecutionMode ? { readMode: host.readExecutionMode } : {}) },
          ),
      };
    },
    () => crypto.randomUUID(),
    policy.intake,
  );
  const hostIdentity = () => {
    const host = resolve();
    return 'reason' in host ? JSON.stringify(host) : nativeIdentity(host, '');
  };
  const preflight = new NativeWorkSubmissionPreflight(hostIdentity, () => {
    submission.close();
    intake.close();
    sync();
  });
  const intakePreflight = new NativeConversationIntakePreflight(hostIdentity, () => {
    intake.close();
    sync();
  });
  const intakeAction = (action: () => Promise<NativeConversationIntakeState | undefined>): Promise<NativeConversationIntakeState | undefined> =>
    intakePreflight.run((_signal, current) => withSelection(action, current));
  return {
    intake: {
      submit: (source, options) => {
        const captured = structuredClone(source);
        const delivery = options ? structuredClone(options) : undefined;
        return intakeAction(() => intake.submit(captured, delivery));
      },
      status: () => intakeAction(() => intake.status()),
      retry: () => intakeAction(() => intake.retry()),
      stop: () => {
        const expected = intake.currentRequest();
        intakePreflight.close();
        return expected ? intakeAction(() => intake.cancel(expected)) : Promise.resolve(undefined);
      },
      resume: () => intakeAction(() => intake.resume()),
      cancel: (expected) => {
        const original = expected ? { ...expected } : undefined;
        if (!original) intakePreflight.close();
        return intakeAction(() => intake.cancel(original));
      },
      close: () => intakePreflight.close(),
    },
    submitFile: (path) =>
      preflight.run(async (signal, isCurrent) => {
        const host = resolve();
        if ('reason' in host) return { status: 'unavailable', message: host.reason };
        const at = revision;
        try {
          const source = await readNativeWorkSourceFile(path, realpathSync(host.workspace), signal);
          if (!isCurrent() || at !== revision) return;
          return withSelection(() => submission.submitSource(source), isCurrent);
        } catch (error) {
          if (!isCurrent() || at !== revision) return;
          return {
            status: 'invalid',
            message: error instanceof NativeWorkSourceError ? error.message : 'Could not read a regular UTF-8 source JSON file.',
          };
        }
      }),
    submissionStatus: () => preflight.run((_signal, current) => withSelection(() => submission.status(), current)),
    retrySubmission: () => preflight.run((_signal, current) => withSelection(() => submission.retry(), current)),
    discardSubmission: () => preflight.run((_signal, current) => withSelection(() => submission.discard(), current)),
    sync,
    dispose() {
      preflight.close();
      intakePreflight.close();
      to({ kind: 'closed' });
      identityOwner.clear();
    },
  };
}
