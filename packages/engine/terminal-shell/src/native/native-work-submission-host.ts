import { isNativePairedPrincipal } from './native-paired-principal.js';
import { createNativeHostFetch } from './native-host-fetch.js';
import { realpathSync } from 'node:fs';
import { createOperatorApiClient, type OperatorRemoteClient } from '@goodvibes-jev/engine/operator-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkSubmissionClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-submission-client';
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
let identitySequence = 0;
/** One live shell owns these observations. Public labels contain no bearer or
 * source bytes; the durable journal separately binds the authenticated principal.
 * Only the latest exact frame per project is retained, at most 16 projects.
 */
export function createNativeSubmissionIdentity(identityFormat: NativeHostIdentityFormat = 'credential') {
    const observations = new Map<string, { readonly frame: readonly (string | null)[]; readonly id: string }>();
    return {
        identify(host: NativeSubmissionHost, projectId: string): string {
            const frame = [host.baseUrl, host.token, realpathSync(host.workspace), projectId, host.journalPath ?? null,
                ...(identityFormat === 'paired' ? [host.selectionIdentity ?? null, host.expectedPrincipalId ?? null] : [host.credentialIdentity ?? null])];
            const prior = observations.get(projectId);
            if (prior && prior.frame.length === frame.length && prior.frame.every((value, index) => value === frame[index])) return prior.id;
            if (!Number.isSafeInteger(++identitySequence)) throw new Error('Native submission identity exhausted');
            const id = `native-submission-${identitySequence}`;
            if (!observations.has(projectId) && observations.size >= 16) {
                const oldest = observations.keys().next().value;
                if (oldest !== undefined) observations.delete(oldest);
            }
            observations.set(projectId, { frame, id });
            return id;
        },
        clear(): void { observations.clear(); },
    };
}
export function createNativeWorkSubmissionBinding(host: NativeSubmissionHost, projectId: string, current: () => boolean = () => true): NativeWorkSubmissionBinding {
    let disposed = false;
    const operator = createOperatorApiClient({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current: () => !disposed && current() }) });
    const invoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
        if (disposed || !current())
            throw new Error('Native submission host selection changed');
        // The principal is read once per operation (readPrincipal). The daemon
        // authenticates the same token on every request and refuses a revoked
        // one, so asking who we are before each request repeats that check.
        const value = await operator.invoke(...args);
        if (disposed || !current())
            throw new Error('Native submission host selection changed');
        return value;
    }) as OperatorRemoteClient['invoke'];
    const reader = createOperatorWorkLedgerReadClient({ invoke }, projectId);
    const client = createOperatorNativeWorkSubmissionClient({ invoke }, projectId);
    return { client,
        readPrincipal: signal => invoke('control.auth.current', {}, { signal }).then(auth => {
            // The host states the credential kind; this exact principal comes from the live host.
            if (!isNativePairedPrincipal(auth, host.expectedPrincipalId)) {
                throw Object.assign(new Error('Native submission requires a paired device'), { code: 'PAIRED_OWNER_REQUIRED' });
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
