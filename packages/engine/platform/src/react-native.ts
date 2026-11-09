import { ConfigurationError } from '@goodvibes-jev/engine/errors';

export { forSession } from './companion-realtime.js';
import {
  createRemoteRuntimeEvents,
  createWebSocketConnector,
  type RemoteRuntimeEvents,
} from '@goodvibes-jev/engine/transport-realtime';
import {
  createGoodVibesPlatform,
  type GoodVibesPlatformOptions,
  type GoodVibesPlatform,
  type RuntimeEventRecord,
} from './client.js';

export interface ReactNativeGoodVibesPlatformOptions extends GoodVibesPlatformOptions {
  readonly WebSocketImpl?: typeof WebSocket | undefined;
}

export interface ReactNativeGoodVibesRealtime {
  runtime(): RemoteRuntimeEvents<RuntimeEventRecord>;
  viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord>;
}

export type ReactNativeGoodVibesPlatform =
  Omit<GoodVibesPlatform, 'realtime'> & {
    readonly realtime: ReactNativeGoodVibesRealtime;
  };

function requireReactNativeWebSocket(webSocketImpl?: typeof WebSocket): typeof WebSocket {
  const resolved = webSocketImpl ?? globalThis.WebSocket;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError(
      'React Native realtime requires a WebSocket implementation. Pass options.WebSocketImpl or use a runtime that provides global WebSocket.',
    );
  }
  return resolved;
}

/**
 * Create a GoodVibes platform instance for React Native.
 *
 * Key differences from the browser factory:
 * - Realtime is WebSocket-only (`realtime.runtime()` / `realtime.viaWebSocket()`).
 *   SSE is not available in React Native.
 * - Requires a `WebSocket` implementation (e.g. the global provided by the
 *   React Native runtime or the `react-native` package). Pass
 *   `options.WebSocketImpl` when the global is not available.
 * - The daemon authenticates the upgrade request itself and answers 401 when
 *   it carries no `Authorization` header, so realtime needs a wrapper
 *   implementation that attaches the bearer token via React Native's
 *   `(url, protocols, { headers })` constructor form (see the example).
 * - Returns `ReactNativeGoodVibesPlatform` (extends `GoodVibesPlatform` with a
 *   React-Native-specific `realtime` namespace).
 *
 * @example
 * // Example only: replace baseUrl and authToken with your own values.
 * import { createReactNativeGoodVibesPlatform } from '@goodvibes-jev/engine/platform/react-native';
 *
 * const platform = createReactNativeGoodVibesPlatform({
 *   baseUrl: 'https://daemon.example.com',
 *   authToken: await SecureStore.getItemAsync('token'),
 * });
 *
 * // The upgrade must carry the bearer token; RN's WebSocket accepts headers.
 * const token = await SecureStore.getItemAsync('token');
 * const AuthorizedWebSocket = function (url: string | URL): WebSocket {
 *   return new (WebSocket as never)(String(url), [], {
 *     headers: { Authorization: `Bearer ${token}` },
 *   });
 * } as unknown as typeof WebSocket;
 *
 * const events = platform.realtime.viaWebSocket(AuthorizedWebSocket);
 * events.agents.on('AGENT_SPAWNING', ({ agentId }) => console.log(agentId));
 */
export function createReactNativeGoodVibesPlatform(
  options: ReactNativeGoodVibesPlatformOptions,
): ReactNativeGoodVibesPlatform {
  // Normalize baseUrl once, trimmed and validated, so both HTTP and WebSocket
  // connectors use the same value regardless of how the caller passed it.
  const baseUrl = options.baseUrl.trim();
  const realtime = {
      ...(options.realtime ?? {}),
      webSocketReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.webSocketReconnect ?? {}),
      },
  };
  const base = createGoodVibesPlatform({
    ...options,
    // Default retry: 3 attempts with exponential back-off capped at 2 s.
    // React Native links can be flaky (radio, background suspension) so a
    // conservative retry budget prevents cascading failures.
    retry: options.retry ?? {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    },
    realtime,
    WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
  });
  const getAuthToken = () => base.auth.getToken();

  return {
    ...base,
    realtime: {
      runtime(): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector(
            baseUrl,
            getAuthToken,
            requireReactNativeWebSocket(options.WebSocketImpl),
            {
              reconnect: realtime.webSocketReconnect,
              onError: options.realtime?.onError,
            },
          ),
          {
            onError: (error) => options.realtime?.onError?.(error),
          },
        );
      },
      viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector(
            baseUrl,
            getAuthToken,
            requireReactNativeWebSocket(webSocketImpl ?? options.WebSocketImpl),
            {
              reconnect: realtime.webSocketReconnect,
              onError: options.realtime?.onError,
            },
          ),
          {
            onError: (error) => options.realtime?.onError?.(error),
          },
        );
      },
    },
  };
}

export {
  createIOSKeychainTokenStore,
  type IOSKeychainTokenStore,
  type IOSKeychainTokenStoreOptions,
  type KeychainAccessible,
} from './client-auth/ios-keychain-token-store.js';

export {
  createAndroidKeystoreTokenStore,
  type AndroidKeystoreTokenStore,
  type AndroidKeystoreTokenStoreOptions,
  type AndroidAccessControl,
  type AndroidAccessible,
} from './client-auth/android-keystore-token-store.js';
