/**
 * expo-secure-token-store.ts
 *
 * Token store backed by `expo-secure-store`, Expo's hardware-backed secure
 * storage layer (iOS Keychain / Android Keystore behind the scenes).
 *
 * `expo-secure-store` is an **optional peer dependency**, this module does
 * NOT eagerly import it. The module is loaded lazily so the platform remains
 * loadable in environments where the native module is absent.
 *
 * ## Installation
 *
 * ```sh
 * expo install expo-secure-store
 * ```
 *
 * Error messages use the format: [what happened] · [why] · [what to do]
 */
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { GoodVibesTokenStore } from './types.js';
import { createNativeTokenPersistence } from './native-token-persistence.js';

// ---------------------------------------------------------------------------
// Accessible constant names
// ---------------------------------------------------------------------------

/**
 * String union of the `SecureStore.ACCESSIBLE_*` constant names.
 * Resolved by property lookup on the dynamically-imported module so that
 * numeric native values never need to be hard-coded here.
 */
export type ExpoSecureStoreAccessible =
  | 'AFTER_FIRST_UNLOCK'
  | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
  | 'ALWAYS'
  | 'ALWAYS_THIS_DEVICE_ONLY'
  | 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY'
  | 'WHEN_UNLOCKED'
  | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExpoSecureTokenStoreOptions {
  /**
   * The key used for the secure-store entry.
   * @default 'goodvibes-platform-token'
   */
  readonly key?: string | undefined;

  /**
   * iOS Keychain service name. Passed through to `SecureStore.setItemAsync`
   * as `keychainService`. Has no effect on Android.
   */
  readonly keychainService?: string | undefined;

  /**
   * Controls when the stored data is accessible. Maps to the
   * `SecureStore.ACCESSIBLE_*` constants.
   *
   * @default 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
   */
  readonly accessible?: ExpoSecureStoreAccessible | undefined;
}

// ---------------------------------------------------------------------------
// Dynamic loader (cached per process)
// ---------------------------------------------------------------------------

type ExpoSecureStoreOptions = {
  keychainService?: string | undefined;
  keychainAccessible?: number | undefined;
};

type ExpoSecureStoreModule = Partial<Record<ExpoSecureStoreAccessible, number>> & {
  setItemAsync(key: string, value: string, options?: ExpoSecureStoreOptions): Promise<void>;
  getItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<string | null>;
  deleteItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<void>;
};

const EXPO_SECURE_STORE_MODULE: string = 'expo-secure-store';

let _mod: ExpoSecureStoreModule | null = null;

async function loadExpoSecureStore(): Promise<ExpoSecureStoreModule> {
  if (_mod !== null) return _mod;
  try {
    _mod = (await import(EXPO_SECURE_STORE_MODULE)) as ExpoSecureStoreModule;
    return _mod;
  } catch {
    throw new GoodVibesError(
      'expo-secure-store is not installed, the Expo secure token store cannot be initialised. ' +
        'This optional peer dependency is required to persist tokens in native hardware-backed storage. ' +
        'Run `expo install expo-secure-store` and rebuild your app.',
      {
        code: 'EXPO_SECURE_STORE_NOT_INSTALLED',
        category: 'config',
        source: 'config',
        recoverable: false,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Extended store interface (expiresAt support)
// ---------------------------------------------------------------------------

export interface ExpoSecureTokenStore extends GoodVibesTokenStore {
  /**
   * Persist a token together with an optional Unix-epoch expiry (ms).
   * Both values are serialised into a single secure-store entry.
   * Picked up automatically by the `TokenStore` wrapper via duck-typing.
   */
  setTokenEntry(token: string | null, expiresAt?: number): Promise<void>;

  /**
   * Return the stored token and optional expiry timestamp.
   * Picked up automatically by the `TokenStore` wrapper via duck-typing.
   */
  getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `GoodVibesTokenStore` backed by `expo-secure-store`.
 *
 * Both the `token` and `expiresAt` values are serialised as a single JSON
 * blob into one secure-store entry, keeping the keychain tidy.
 *
 * `expo-secure-store` is an **optional peer dependency**, install it with:
 *
 * ```sh
 * expo install expo-secure-store
 * ```
 *
 * @example
 * ```ts
 * import { createExpoSecureTokenStore, createExpoGoodVibesPlatform } from '@goodvibes-jev/engine/platform/expo';
 *
 * const tokenStore = createExpoSecureTokenStore({ key: 'gv-token' });
 * const platform = createExpoGoodVibesPlatform({ baseUrl: 'https://daemon.example.com', tokenStore });
 * ```
 */
export function createExpoSecureTokenStore(
  options: ExpoSecureTokenStoreOptions = {},
  __loadModule?: () => Promise<unknown>,
): ExpoSecureTokenStore {
  const requestedKey = options.key;
  const key = requestedKey?.trim() || 'goodvibes-platform-token';
  // Only an omitted key may consult the deployed earlier default. Explicit
  // keys never adopt another namespace; both addresses use the original service.
  const previousKey = requestedKey === undefined ? 'goodvibes-sdk-token' : undefined;
  const accessible: ExpoSecureStoreAccessible =
    options.accessible ?? 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
  const keychainService = options.keychainService;

  async function resolveModule(): Promise<ExpoSecureStoreModule> {
    if (__loadModule !== undefined) {
      return __loadModule() as Promise<ExpoSecureStoreModule>;
    }
    return loadExpoSecureStore();
  }

  function buildStoreOptions(mod: ExpoSecureStoreModule): ExpoSecureStoreOptions {
    const opts: ExpoSecureStoreOptions = {};
    const accessibleValue = mod[accessible];
    if (accessibleValue !== undefined) {
      opts.keychainAccessible = accessibleValue;
    } else {
      throw new Error(
        `expo-secure-store does not expose ${accessible}; choose a supported SecureStore accessibility constant.`,
      );
    }
    if (keychainService !== undefined) {
      opts.keychainService = keychainService;
    }
    return opts;
  }

  const { readPayload, writePayload } = createNativeTokenPersistence(async () => {
    const mod = await resolveModule(), nativeOptions = buildStoreOptions(mod);
    const get = mod.getItemAsync.bind(mod), set = mod.setItemAsync.bind(mod), remove = mod.deleteItemAsync.bind(mod);
    return {
      clearBarrier: key === 'goodvibes-platform-token',
      read: () => get(key, { ...nativeOptions }),
      write: value => set(key, value, { ...nativeOptions }),
      remove: () => remove(key, { ...nativeOptions }),
      ...(previousKey === undefined ? {} : { previous: {
        read: () => get(previousKey, { ...nativeOptions }),
        remove: () => remove(previousKey, { ...nativeOptions }),
      } }),
    };
  }, 'Expo secure token store');

  return {
    async getToken(): Promise<string | null> {
      const payload = await readPayload();
      return payload?.token ?? null;
    },

    async setToken(token: string | null): Promise<void> {
      if (token === null) {
        await writePayload(null);
        return;
      }
      await writePayload({ token, expiresAt: null });
    },

    async clearToken(): Promise<void> {
      await writePayload(null);
    },

    async setTokenEntry(token: string | null, expiresAt?: number): Promise<void> {
      if (token === null) {
        await writePayload(null);
        return;
      }
      await writePayload({ token, expiresAt: expiresAt ?? null });
    },

    async getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }> {
      const payload = await readPayload();
      if (payload === null) return { token: null };
      const expiresAt = payload.expiresAt ?? undefined;
      return expiresAt !== undefined ? { token: payload.token, expiresAt } : { token: payload.token };
    },
  };
}
