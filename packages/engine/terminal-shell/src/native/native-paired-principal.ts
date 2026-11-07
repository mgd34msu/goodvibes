import type { OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';

/** Shared-token migration authority, verified by the selected host before minting a device token. */
export function isHostPairingBootstrapPrincipal(auth: OperatorMethodOutput<'control.auth.current'>): boolean {
    return auth.authenticated === true && auth.admin === true && auth.principalKind === 'token'
        && auth.principalId === 'shared-token' && Array.isArray(auth.scopes)
        && auth.scopes.some(scope => scope === '*' || scope === 'write:control-plane');
}

/** One bounded, strictly decoded migration response. Oversized streams are cancelled, never retained. */
export async function readHostPairingResponse(response: Response): Promise<unknown> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const bytes = new Uint8Array(16_384);
    let size = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (size + chunk.value.byteLength > bytes.length) {
                await reader.cancel();
                return null;
            }
            bytes.set(chunk.value, size);
            size += chunk.value.byteLength;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    } finally { reader.releaseLock(); }
}

/** The live authority required by native intake, not the coarse authMode label. */
export function isNativePairedPrincipal(auth: OperatorMethodOutput<'control.auth.current'>, expectedPrincipalId?: string | undefined): auth is OperatorMethodOutput<'control.auth.current'> & {
    readonly principalId: string;
} {
    return auth.authenticated === true && auth.admin === true && auth.principalKind === 'token'
        && typeof auth.principalId === 'string' && auth.principalId.length > 0 && auth.principalId.length <= 200
        && auth.principalId !== 'shared-token'
        && (expectedPrincipalId === undefined || auth.principalId === expectedPrincipalId)
        && Array.isArray(auth.scopes)
        && ['read:work-ledger', 'write:work-ledger'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope));
}
