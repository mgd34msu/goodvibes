import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import type { NativeWorkLedgerBinding } from './work-ledger-projection.js';
export function createNativeWorkLedgerReadBinding(
  operator: Pick<OperatorRemoteClient, 'invoke'> & { dispose(): void },
  projectId: string,
  ports: {
    readonly onUnavailable: (error: Error) => void;
    readonly execution: Pick<OperatorRemoteClient, 'invoke'>;
    readonly beforeDispose?: (() => void) | undefined;
  },
): NativeWorkLedgerBinding {
  const reader = createOperatorWorkLedgerReadClient(operator, projectId, { onUnavailable: ports.onUnavailable });
  return {
    available: true,
    execution: createOperatorNativeWorkExecutionClient(ports.execution, projectId),
    client: {
      projectId: reader.projectId,
      readSnapshot: () => reader.readSnapshot(),
      history: (cursor) => reader.history(cursor),
      subscribe: (listener) => reader.subscribe(listener),
      dispose() {
        ports.beforeDispose?.();
        try {
          reader.dispose();
        } finally {
          operator.dispose();
        }
      },
    },
  };
}
