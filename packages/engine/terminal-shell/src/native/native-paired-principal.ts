import type { OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';

type CurrentAuth = OperatorMethodOutput<'control.auth.current'>;

/**
 * The credential the host says the caller presented (`local`, `shared-token`,
 * `device-token`, `agent` or `user-session`). Read from the host's answer,
 * never inferred from a principal's name.
 */
export function currentAuthCredential(auth: CurrentAuth): string | null {
    const credential = (auth as { readonly credential?: unknown }).credential;
    return typeof credential === 'string' ? credential : null;
}

/**
 * Shared-token migration authority, verified by the selected host before
 * minting a device token: the operator token, from the daemon's own machine
 * (`local`) or from elsewhere.
 */
export function isHostPairingBootstrapPrincipal(auth: CurrentAuth): boolean {
    const credential = currentAuthCredential(auth);
    return auth.authenticated === true && auth.admin === true && (credential === 'shared-token' || credential === 'local')
        && Array.isArray(auth.scopes)
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

export interface MintedHostPairingToken {
    readonly id: string;
    readonly token: string;
    readonly name: string;
    readonly createdAt: number;
}

/**
 * The one predicate a migration response must satisfy before anything is stored.
 * `createdAt` follows the credential stores' own rule (a positive safe integer),
 * so a value a store would refuse is refused before any write is attempted.
 */
export function parseMintedPairingToken(payload: unknown, name: string): MintedHostPairingToken | null {
    const minted = payload && typeof payload === 'object' && 'token' in payload ? payload.token : null;
    if (!minted || typeof minted !== 'object') return null;
    const { id, token, name: mintedName, createdAt } = minted as Record<string, unknown>;
    if (typeof id !== 'string' || !/^pair-[0-9a-f-]{36}$/i.test(id)) return null;
    if (typeof token !== 'string' || !/^gvp_[A-Za-z0-9_-]{32}$/.test(token)) return null;
    if (mintedName !== name) return null;
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
    return { id, token, name, createdAt };
}

/** Live paired operator authority (a device token), with operation-specific scopes. */
export function isPairedOperatorPrincipal(auth: CurrentAuth, scopes: readonly string[], expectedPrincipalId?: string | undefined): auth is CurrentAuth & {
    readonly principalId: string;
} {
    return auth.authenticated === true && auth.admin === true && currentAuthCredential(auth) === 'device-token'
        && typeof auth.principalId === 'string' && auth.principalId.length > 0 && auth.principalId.length <= 200
        && (expectedPrincipalId === undefined || auth.principalId === expectedPrincipalId)
        && Array.isArray(auth.scopes)
        && scopes.every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope));
}

/** A paired device holding the native work scopes: what a completed pairing verifies. */
export function isNativePairedPrincipal(auth: CurrentAuth, expectedPrincipalId?: string | undefined): auth is CurrentAuth & { readonly principalId: string } {
    return isPairedOperatorPrincipal(auth, ['read:work-ledger', 'write:work-ledger'], expectedPrincipalId);
}

/**
 * Live owner authority for owner-only work, with operation-specific scopes:
 * a paired device, or an app on the daemon's own machine presenting the
 * operator token it already holds (`local`), which needs no pairing.
 */
export function isOwnerOperatorPrincipal(auth: CurrentAuth, scopes: readonly string[], expectedPrincipalId?: string | undefined): auth is CurrentAuth & {
    readonly principalId: string;
} {
    const credential = currentAuthCredential(auth);
    return auth.authenticated === true && auth.admin === true && (credential === 'device-token' || credential === 'local')
        && typeof auth.principalId === 'string' && auth.principalId.length > 0 && auth.principalId.length <= 200
        && (expectedPrincipalId === undefined || auth.principalId === expectedPrincipalId)
        && Array.isArray(auth.scopes)
        && scopes.every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope));
}

/** The live authority native intake and submission require: the owner's own machine or a paired device. */
export function isNativeOwnerPrincipal(auth: CurrentAuth, expectedPrincipalId?: string | undefined): auth is CurrentAuth & { readonly principalId: string } {
    return isOwnerOperatorPrincipal(auth, ['read:work-ledger', 'write:work-ledger'], expectedPrincipalId);
}
