import type { GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import { createNativeHostFetch, NativeHostSelectionChangedError } from './native-host-fetch.js';
import { createNativeHostedTurnClient } from './native-hosted-turn.js';
import { isNativeOwnerPrincipal } from './native-paired-principal.js';
import { createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
import { createOperatorApiClient, type OperatorRemoteClient } from '@goodvibes-jev/engine/operator-client';
import { createOperatorNativeConversationIntakeClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';
import type { NativeSubmissionHost } from './native-work-submission-host.js';
import { NativeIntakeFailure, type NativeConversationIntakeBinding } from './native-conversation-intake.js';
export function createNativeConversationIntakeBinding(host: NativeSubmissionHost, projectId: string, current: () => boolean = () => true, options: {
    readonly allowHosted?: boolean | undefined;
    readonly readMode?: (() => GatePresetName) | undefined;
} = {}): NativeConversationIntakeBinding {
    const allowHosted = options.allowHosted === true;
    const readMode = options.readMode;
    let disposed = false;
    // The engine may verify a queued permit after this intake operation has detached.
    // Each verification opens a fresh connection, fenced to the exact selected host.
    const invoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
        const available = () => current() && (!disposed || args[0] === 'workLedger.intake.get');
        if (!available())
            throw new NativeHostSelectionChangedError();
        const operator = createOperatorApiClient({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current: available }) });
        try {
            // The host authenticates this token on every request, refuses a revoked
            // one, and checks the owner, scopes and project of each intake, hosted
            // turn and execution call itself; the principal was read once per
            // operation (readPrincipal), so nothing is re-read here.
            const value = await operator.invoke(...args);
            if (!available())
                throw new NativeHostSelectionChangedError();
            return value;
        }
        finally {
            operator.dispose();
        }
    }) as OperatorRemoteClient['invoke'];
    let principalId: string | undefined;
    const hostedInvoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
        // Every hosted request names this project and the host refuses another
        // one, and its owner check covers the principal and write:sessions.
        if (!principalId)
            throw new NativeIntakeFailure('principal', 'Native hosted turn requires the principal read for this operation');
        return invoke(...args);
    }) as OperatorRemoteClient['invoke'];
    const client = createOperatorNativeConversationIntakeClient({ invoke }, projectId);
    const execution = createOperatorNativeWorkExecutionClient({ invoke }, projectId);
    return {
        client, execution, ...(allowHosted ? { hostedTurn: createNativeHostedTurnClient({ invoke: hostedInvoke }, projectId, readMode) } : {}),
        async readPrincipal(signal) {
            const auth = await invoke('control.auth.current', {}, { signal });
            if (!isNativeOwnerPrincipal(auth, host.expectedPrincipalId)) {
                throw new NativeIntakeFailure('principal', 'Native intake runs from the daemon\'s own machine or a paired device; pair this device (/devices migrate-shared), then retry');
            }
            principalId = auth.principalId;
            return principalId;
        },
        dispose() { disposed = true; try {
            client.dispose();
        }
        finally {
            execution.dispose();
        } },
    };
}
