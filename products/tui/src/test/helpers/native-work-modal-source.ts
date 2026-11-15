import { createBoundNativeWorkLedgerView, type NativeLedgerHost } from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger-host';
import type { NativeWorkLedgerBinding } from '@goodvibes-jev/engine/terminal-shell/native/work-ledger-projection';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import type { NativeWorkLedgerModalSource } from '../../runtime/native-work-ledger-host.ts';

const FIXTURE_HOST = { baseUrl: 'http://native-fixture.invalid', token: 'fixture-token', workspace: '/', credentialIdentity: 'fixture-host' };

/**
 * A /work modal source over the shared host with the project already selected and
 * the binding the test supplies. `replaceHost` stands for a host or credential change.
 */
export function nativeWorkModalSource(projectId: string, bind: () => NativeWorkLedgerBinding): NativeWorkLedgerModalSource & { replaceHost(host: NativeLedgerHost): void } {
  let host: NativeLedgerHost = FIXTURE_HOST;
  let listener: () => void = () => {};
  const view = createBoundNativeWorkLedgerView(
    () => host,
    () => listener(),
    { identityFormat: 'credential', intake: { allowHosted: false, allowSelectedDiff: true } },
    () => bind(),
    async () => projectId,
  );
  view.selectProject(projectId);
  return {
    view,
    watch(next) {
      listener = next;
      return () => {
        if (listener === next) listener = () => {};
      };
    },
    replaceHost(next) {
      host = next;
    },
  };
}

/** The same source reading through an operator client (a live platform in tests). */
export function operatorWorkModalSource(projectId: string, operator: Pick<OperatorRemoteClient, 'invoke'>) {
  return nativeWorkModalSource(projectId, () => ({
    available: true,
    client: createOperatorWorkLedgerReadClient(operator, projectId),
    execution: createOperatorNativeWorkExecutionClient(operator, projectId),
  }));
}
