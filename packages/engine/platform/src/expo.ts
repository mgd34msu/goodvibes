import {
  createReactNativeGoodVibesPlatform,
  type ReactNativeGoodVibesPlatform,
  type ReactNativeGoodVibesPlatformOptions,
} from './react-native.js';

// ExpoGoodVibesPlatformOptions is intentionally identical to ReactNativeGoodVibesPlatformOptions.
// A type alias avoids the empty-interface lint warning while preserving a
// distinct public name in the Expo entrypoint.
export type ExpoGoodVibesPlatformOptions = ReactNativeGoodVibesPlatformOptions;

export { forSession } from './companion-realtime.js';

/**
 * Create a GoodVibes platform instance from the Expo-specific entrypoint.
 */
export function createExpoGoodVibesPlatform(options: ExpoGoodVibesPlatformOptions): ReactNativeGoodVibesPlatform {
  return createReactNativeGoodVibesPlatform(options);
}

export {
  createExpoSecureTokenStore,
  type ExpoSecureTokenStore,
  type ExpoSecureTokenStoreOptions,
  type ExpoSecureStoreAccessible,
} from './client-auth/expo-secure-token-store.js';
