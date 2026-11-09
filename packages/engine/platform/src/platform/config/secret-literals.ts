import { SecretsManager, type SecretsManagerOptions } from './secrets.js';
import { isSecretRefInput } from './secret-refs.js';
import { isGoodVibesSecretReferenceValue } from './secret-backed-config.js';
const RAW_SECRET_LITERAL_PREFIX = '__GOODVIBES_LITERAL_V1__';
function shouldStoreAsLiteral(value: string): boolean {
    return value.startsWith(RAW_SECRET_LITERAL_PREFIX)
        || (isSecretRefInput(value) && !isGoodVibesSecretReferenceValue(value));
}
function encodeLiteralSecret(value: string): string {
    return `${RAW_SECRET_LITERAL_PREFIX}${Buffer.from(JSON.stringify({ value }), 'utf-8').toString('base64url')}`;
}
function decodeLiteralSecret(value: string): string | null {
    if (!value.startsWith(RAW_SECRET_LITERAL_PREFIX))
        return null;
    try {
        const decoded = Buffer.from(value.slice(RAW_SECRET_LITERAL_PREFIX.length), 'base64url').toString('utf-8');
        const parsed = JSON.parse(decoded) as unknown;
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as {
            value?: unknown | undefined;
        }).value !== 'string')
            return null;
        return (parsed as {
            value: string;
        }).value;
    }
    catch {
        return null;
    }
}
/** Marks a manager that already carries the raw-literal read/write pair. */
const RAW_LITERAL_HANDLING_INSTALLED = Symbol.for('goodvibes.agent.rawSecretLiteralHandling');
/**
 * Give an owned `SecretsManager` the platform raw-literal read/write pair.
 *
 * ── What the pair does ────────────────────────────────────────────────────
 *
 * The platform base class treats a STORED value that parses as a secret reference
 * as a pointer and resolves it: `op://…` shells out to the 1Password CLI,
 * `bw://`/`vaultwarden://`/`bws://` to the Bitwarden CLIs, and a JSON-ref
 * string to whichever source it names. That is right for a value the owner
 * meant as a pointer.
 *
 * It is wrong for a value that IS the credential and merely looks like one of
 * those. A password that literally begins `op://` would be handed to a
 * subprocess instead of to the provider, and the provider would be told the
 * credential is unusable. So a value that parses as a NON-`goodvibes://`
 * reference is stored wrapped, and unwrapped on the way back out,
 * `goodvibes://secrets/…` is excluded because that IS the platform's own
 * pointer form and must keep resolving (`/secrets link` writes exactly that).
 *
 * ── Why a function that patches an instance, rather than a subclass ───────
 *
 * `createClientRuntimeServices` builds the credential store itself, through
 * `createRuntimeSecretsManager`, and hands the SAME instance to the provider
 * stack, the service registry and the agent orchestrator. It accepts no
 * secrets-manager (or secrets-manager factory) option, so there is no way to
 * give it a literal-aware subclass. Keeping a second, subclassed manager beside
 * it would be worse than doing nothing: the settings modal would wrap a value
 * on write while the provider stack read the wrapper back verbatim and sent
 * the wrapper to the provider.
 *
 * Installing the pair on the instance the floor built keeps one manager and
 * one behaviour for every reader. It is applied through the floor's
 * `providerRegistryFactory` callback (see runtime/services.ts), which is the
 * first point at which that instance is in the consuming product's hands AND still runs
 * before the floor's own boot credential refresh reads it, `resolveApiKeys`
 * calls `secrets.get(...)` inside the synchronous prefix of
 * `refreshProviderCredentials()`, so patching after the factory returns would
 * catch only part of that first sweep.
 *
 * The platform option that would retire this: a
 * `secretsManagerFactory?: (input: DaemonSecretsCompositionInput) => SecretsManager`
 * on `ClientRuntimeServicesOptions`, defaulting to `createRuntimeSecretsManager`
 *, the exact shape `providerRegistryFactory` already has for the registry.
 *
 * Idempotent: installing twice on the same instance is a no-op.
 */
export function applyRawSecretLiteralHandling<T extends SecretsManager>(manager: T): T {
    const marked = manager as T & {
        [RAW_LITERAL_HANDLING_INSTALLED]?: true | undefined;
    };
    if (marked[RAW_LITERAL_HANDLING_INSTALLED])
        return manager;
    // Captured from the instance's own prototype chain rather than named as a
    // base class, so this stays correct for a subclass that overrides either.
    const baseGet = manager.get.bind(manager);
    const baseSet = manager.set.bind(manager);
    Object.defineProperties(manager, {
        [RAW_LITERAL_HANDLING_INSTALLED]: { value: true, enumerable: false },
        get: {
            value: async (key: string): Promise<string | null> => {
                const envValue = process.env[key];
                if (envValue !== undefined && shouldStoreAsLiteral(envValue)) {
                    return decodeLiteralSecret(envValue) ?? envValue;
                }
                const value = await baseGet(key);
                if (value === null)
                    return null;
                return decodeLiteralSecret(value) ?? value;
            },
            writable: true,
            configurable: true,
        },
        set: {
            value: async (key: string, value: string, options?: Parameters<SecretsManager['set']>[2] | undefined): Promise<void> => {
                await baseSet(key, shouldStoreAsLiteral(value) ? encodeLiteralSecret(value) : value, options);
            },
            writable: true,
            configurable: true,
        },
    });
    return manager;
}
/** A standalone owned store with the same literal semantics as composed clients. */
export class LiteralSecretsManager extends SecretsManager {
    constructor(options: SecretsManagerOptions) {
        super(options);
        applyRawSecretLiteralHandling(this);
    }
}
