import type { OperatorRemoteClient } from '@goodvibes/engine/operator-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes/engine/platform/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkExecutionClient } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client';
import type { NativeWorkLedgerBinding } from './work-ledger-projection.js';
export function createNativeWorkLedgerReadBinding(
  operator: Pick<OperatorRemoteClient, 'invoke'> & { dispose(): void },
  projectId: string,
  ports: {
    readonly execution: Pick<OperatorRemoteClient, 'invoke'>;
    readonly beforeDispose?: (() => void) | undefined;
  },
): NativeWorkLedgerBinding {
  const reader = createOperatorWorkLedgerReadClient(operator, projectId);
  return {
    available: true,
    execution: createOperatorNativeWorkExecutionClient(ports.execution, projectId),
    client: {
      projectId: reader.projectId,
      readSnapshot: () => reader.readSnapshot(),
      history: (cursor) => reader.history(cursor),
      subscribe: (listener, onUnavailable, onResumed) => reader.subscribe(listener, onUnavailable, onResumed),
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
