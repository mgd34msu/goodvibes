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

/**
 * React Native's WebSocket constructor: unlike the browser one it takes a third
 * argument whose `headers` are sent on the upgrade request.
 */
type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { readonly headers?: Record<string, string> },
) => WebSocket;

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
 * - The daemon authenticates the upgrade request itself, so every socket is
 *   built with React Native's `(url, protocols, { headers })` constructor form
 *   carrying `Authorization: Bearer <token>`, with the token resolved for that
 *   connect (refreshed first when it is near expiry). A reconnect after a
 *   token refresh presents the new token.
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
 * const events = platform.realtime.runtime();
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
  // One store read per connect, refreshed first inside the leeway window, as
  // the HTTP transport does, so a (re)connect never presents a stale bearer.
  const getAuthToken = async (): Promise<string | null> => {
    try {
      return await base.auth.currentToken();
    } catch {
      // A refresh that cannot complete leaves the token as it was; connect with it
      // and let the daemon's answer decide, as a request would.
      return base.auth.getToken();
    }
  };
  const connectRuntime = (webSocketImpl: typeof WebSocket | undefined): RemoteRuntimeEvents<RuntimeEventRecord> => {
    const WebSocketImpl = requireReactNativeWebSocket(webSocketImpl);
    // The DOM typing has no third constructor argument; React Native's runtime does.
    const construct = WebSocketImpl as unknown as ReactNativeWebSocketConstructor;
    return createRemoteRuntimeEvents(
      createWebSocketConnector(baseUrl, getAuthToken, WebSocketImpl, {
        reconnect: realtime.webSocketReconnect,
        onError: options.realtime?.onError,
        // The daemon authenticates the upgrade itself, so the header carries
        // the token this connect resolved; the auth frame repeats it.
        createSocket: (url, token) => new construct(url, [], token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      }),
      { onError: (error) => options.realtime?.onError?.(error) },
    );
  };

  return {
    ...base,
    realtime: {
      runtime(): RemoteRuntimeEvents<RuntimeEventRecord> {
        return connectRuntime(options.WebSocketImpl);
      },
      viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord> {
        return connectRuntime(webSocketImpl ?? options.WebSocketImpl);
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
