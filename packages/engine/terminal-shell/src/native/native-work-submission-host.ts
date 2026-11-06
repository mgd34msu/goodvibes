import { isNativePairedPrincipal } from './native-paired-principal.js';
import { createNativeHostFetch } from './native-host-fetch.js';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOperatorSdk, type OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkSubmissionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import type { NativeWorkSubmissionBinding } from './native-work-submission.js';
export type NativeHostIdentityFormat = 'credential' | 'paired';
export interface NativeSubmissionHost {
    readonly baseUrl: string;
    readonly token: string;
    readonly workspace: string;
    readonly journalPath?: string | undefined;
    readonly credentialIdentity?: string | undefined;
    readonly selectionIdentity?: string | undefined;
    readonly expectedPrincipalId?: string | undefined;
}
export function nativeSubmissionIdentity(host: NativeSubmissionHost, projectId: string, identityFormat: NativeHostIdentityFormat = 'credential'): string {
    return createHash('sha256').update(JSON.stringify([host.baseUrl, host.token, realpathSync(host.workspace), projectId, host.journalPath ?? null,
        ...(identityFormat === 'paired' ? [host.selectionIdentity ?? null, host.expectedPrincipalId ?? null] : [host.credentialIdentity ?? null])])).digest('hex');
}
export function createNativeWorkSubmissionBinding(host: NativeSubmissionHost, projectId: string, current: () => boolean = () => true): NativeWorkSubmissionBinding {
    let disposed = false;
    const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current: () => !disposed && current() }) });
    const invoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
        if (disposed || !current())
            throw new Error('Native submission host selection changed');
        if (host.expectedPrincipalId !== undefined && args[0] !== 'control.auth.current') {
            const auth = await operator.invoke('control.auth.current', {}, args[2]);
            if (disposed || !current())
                throw new Error('Native submission host selection changed');
            if (!isNativePairedPrincipal(auth, host.expectedPrincipalId))
                throw new Error('Native submission paired authority changed');
        }
        const value = await operator.invoke(...args);
        if (disposed || !current())
            throw new Error('Native submission host selection changed');
        return value;
    }) as OperatorRemoteClient['invoke'];
    const reader = createOperatorWorkLedgerReadClient({ invoke }, projectId);
    const client = createOperatorNativeWorkSubmissionClient({ invoke }, projectId);
    return { client,
        readPrincipal: signal => invoke('control.auth.current', {}, { signal }).then(auth => {
            // authMode is intentionally not consulted: shared and paired tokens share
            // that coarse label. This exact principal comes from the live host.
            if (!isNativePairedPrincipal(auth, host.expectedPrincipalId)) {
                throw Object.assign(new Error('Native submission requires an existing paired principal'), { code: 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY' });
            }
            return auth.principalId;
        }),
        readSnapshot: () => reader.readSnapshot(), dispose() {
            disposed = true;
            try {
                client.dispose();
            }
            finally {
                try {
                    reader.dispose();
                }
                finally {
                    operator.dispose();
                }
            }
        } };
}
