import { SECRET_BEARING_CONFIG_PATHS, isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { isSecretRefInput } from './secret-refs.js';
import { isDaemonOwnedConfigKey } from './config-ownership.js';
import { daemonSecretKeyFor } from './daemon-secret-keys.js';
export { normalizeSecretKeyPart } from './daemon-secret-keys.js';
import type { ConfigKey } from './schema.js';
import type { SecretScope, SecretStorageMedium } from './secrets.js';
/**
 * The settings whose value is a credential: a write of one stores the value in
 * the secret store and leaves a `goodvibes://secrets/` reference in the
 * settings file. The same declaration as {@link isSecretBearingConfigKey}
 * (secret-bearing-config-keys.ts), which masking, redaction and the settings
 * admission read, so a key that is masked is always routed and the reverse.
 * Card material is not a setting at all: the settings admission refuses it and
 * cards are kept in the daemon's card store (`/payments add-card`).
 */
export const SECRET_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set(SECRET_BEARING_CONFIG_PATHS as readonly ConfigKey[]);
export interface SecretBackedConfigUpdate {
    readonly configValue: string;
    readonly secretKey?: string | undefined;
    readonly secretValue?: string | undefined;
    readonly clearSecretKey?: string | undefined;
}
export interface SecretBackedConfigManager {
    readonly get: (key: ConfigKey) => unknown;
    readonly setDynamic: (key: ConfigKey, value: unknown) => void;
    readonly validateDynamic?: ((key: ConfigKey, value: unknown) => void) | undefined;
}
export interface SecretBackedSecretStore {
    readonly set: (key: string, value: string, options?: {
        readonly scope?: SecretScope | undefined;
        readonly medium?: SecretStorageMedium | undefined;
    } | undefined) => Promise<void>;
    readonly delete?: ((key: string, options?: {
        readonly scope?: SecretScope | undefined;
        readonly medium?: SecretStorageMedium | undefined;
    } | undefined) => Promise<void>) | undefined;
}
export function isSecretConfigKey(key: string): key is ConfigKey {
    return isSecretBearingConfigKey(key);
}
/** The config and daemon credential paths use the same canonical store-key derivation. */
export const buildGoodVibesSecretKey = daemonSecretKeyFor;
export function buildGoodVibesSecretRef(secretKey: string): string {
    return `goodvibes://secrets/goodvibes/${encodeURIComponent(secretKey)}`;
}
export function isGoodVibesSecretReferenceValue(value: string): boolean {
    const normalized = value.trim();
    return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}
export function isMalformedGoodVibesSecretReferenceValue(value: string): boolean {
    const normalized = value.trim();
    return normalized.startsWith('goodvibes://') && !isGoodVibesSecretReferenceValue(normalized);
}
export function getSecretWriteMedium(policy: unknown): SecretStorageMedium {
    if (policy === 'plaintext_allowed')
        return 'plaintext';
    return 'secure';
}
export function buildSecretBackedConfigUpdate(configKey: ConfigKey, rawValue: string): SecretBackedConfigUpdate {
    const value = rawValue.trim();
    const secretKey = buildGoodVibesSecretKey(configKey);
    if (value.length === 0) {
        return {
            configValue: '',
            clearSecretKey: secretKey,
        };
    }
    if (isGoodVibesSecretReferenceValue(value)) {
        return { configValue: value };
    }
    return {
        configValue: buildGoodVibesSecretRef(secretKey),
        secretKey,
        // The trimmed text, the same one that was tested for emptiness and for a
        // reference: a token pasted with a trailing newline must not be stored with it.
        secretValue: value,
    };
}
/**
 * Where a secret-backed write lands when the caller did not name a scope.
 *
 * A daemon-owned config key (`surfaces.*`, `payments.*`, `controlPlane.*`, ...)
 * names a credential the DAEMON executes with, not this interactive client, so
 * its secret material belongs in the daemon-scoped tier the daemon actually
 * reads, the same rule the platform's config-ownership.ts already applies to the
 * `goodvibes://` reference that points at it.
 *
 * Defaulting these to 'user' (the historical behavior here) split the pair: the
 * reference landed in the daemon's own settings file, because ConfigManager
 * routes daemon-owned keys there, while the value it pointed at sat in a tier
 * the daemon never resolves. The surface reported success and the daemon found
 * nothing. For the mailbox password that is the whole feature failing silently,
 * the daemon is the process that polls IMAP and answers over Telegram, and it
 * does so with every surface closed. A payment card entered through
 * /payments add-card is the same shape of failure at purchase time.
 */
export function defaultSecretBackedScope(configKey: ConfigKey): SecretScope {
    return isDaemonOwnedConfigKey(configKey) ? 'daemon' : 'user';
}
/**
 * How a DAEMON-scoped credential reaches the daemon that will use it.
 *
 * One call, not two: `credentials.set` derives the store key, writes the value,
 * reads it back to verify, and only then points the config key at it. Doing
 * those halves separately from here would leave a window where the config
 * names a reference that resolves to nothing, which every reader treats as a
 * configured-but-broken credential.
 */
export interface DaemonCredentialWriter {
    set(configKey: string, value: string): Promise<unknown>;
    clear(configKey: string): Promise<void>;
}
export type SecretBackedConfigRoute = (configKey: ConfigKey, rawValue: string, update: SecretBackedConfigUpdate) => Promise<boolean>;
/** Preserve connected-owner routing without letting a local fallback swallow a refusal. */
export function createSecretBackedConfigWriter(route?: SecretBackedConfigRoute | undefined) {
    return async function persistSecretBackedConfigValue(configManager: SecretBackedConfigManager, secretsManager: SecretBackedSecretStore | null | undefined, configKey: ConfigKey, rawValue: string, options: {
        readonly scope?: SecretScope | undefined;
        readonly daemonWriter?: DaemonCredentialWriter | null | undefined;
    } = {}): Promise<string> {
        const update = buildSecretBackedConfigUpdate(configKey, rawValue);
        const trimmedValue = rawValue.trim();
        if (route && options.scope === undefined && await route(configKey, trimmedValue, update))
            return update.configValue;
        const scope = options.scope ?? defaultSecretBackedScope(configKey);
        // A daemon-scoped credential is the daemon's to store, and the daemon does
        // the whole reference-and-value sequence atomically. This surface neither
        // writes the config key nor the secret in that case, it would be writing
        // both into a tree the daemon never reads.
        if ((update.secretKey || update.clearSecretKey) && scope === 'daemon' && options.daemonWriter) {
            const trimmed = rawValue.trim();
            if (trimmed.length === 0) {
                await options.daemonWriter.clear(configKey);
                return '';
            }
            await options.daemonWriter.set(configKey, trimmedValue);
            return update.configValue;
        }
        if (update.secretKey && !secretsManager)
            throw new Error('Credential storage is unavailable.');
        if (update.clearSecretKey && !secretsManager?.delete)
            throw new Error('Credential deletion is unavailable.');
        const medium = getSecretWriteMedium(configManager.get('storage.secretPolicy'));
        // Preflight without publishing a reference or modifying config. The final
        // setter rechecks admission after the wait; later I/O failure may leave a
        // stored value, but must never be reported as a completed config commit.
        configManager.validateDynamic?.(configKey, update.configValue);
        // Finish storage before publishing a reference that readers can resolve.
        if (update.secretKey && update.secretValue !== undefined && secretsManager) {
            // A caller can deliberately select a local tier; otherwise config
            // ownership above selects the tier that executes with this value.
            await secretsManager.set(update.secretKey, update.secretValue, { scope: scope, medium });
        }
        configManager.validateDynamic?.(configKey, update.configValue);
        configManager.setDynamic(configKey, update.configValue);
        // Revocation includes material written under earlier storage policies.
        // The reference is unpublished first: failing at the config write must not
        // leave a reference that resolves to a deleted secret.
        if (update.clearSecretKey && secretsManager?.delete) {
            try {
                await secretsManager.delete(update.clearSecretKey, { scope });
            }
            catch {
                // Store errors may echo credential material, so none is included.
                throw new Error('The credential reference was cleared, but its stored value could not be removed. Remove it with /secrets delete.');
            }
        }
        return update.configValue;
    };
}
export const persistSecretBackedConfigValue = createSecretBackedConfigWriter();
