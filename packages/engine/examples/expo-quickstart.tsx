/**
 * Create an Expo client and load current GoodVibes auth state.
 */
import { useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import { createExpoGoodVibesPlatform } from '@goodvibes/engine/platform/expo';

// DOM lib types declare only (url, protocols); the Expo/React Native runtime
// accepts a third { headers } options argument, so the constructor is reached
// through a three-argument view of the same signature.
type HeaderWebSocketCtor = new (
  url: string,
  protocols: string[],
  options: { headers: Record<string, string> },
) => WebSocket;

// The daemon authenticates the WebSocket upgrade request itself; a bare
// `new WebSocket(url)` carries no Authorization header and is answered 401.
// Hand the platform a wrapper implementation that attaches the bearer token.
function authorizedWebSocket(token: string): typeof WebSocket {
  return function AuthorizedWebSocket(url: string | URL): WebSocket {
    return new (WebSocket as unknown as HeaderWebSocketCtor)(
      String(url),
      [],
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } as unknown as typeof WebSocket;
}

export default function App() {
  useEffect(() => {
    let stop = () => {};
    // Set by cleanup so an unmount during the async setup below does not
    // leave a live subscription behind.
    let cancelled = false;

    void (async () => {
      try {
        const token = await SecureStore.getItemAsync('goodvibes_token');
        if (cancelled) return;
        if (!token) {
          // First launch or signed out: show your sign-in screen instead of calling the daemon.
          console.warn('No GoodVibes token stored; sign in first.');
          return;
        }
        const platformClient = createExpoGoodVibesPlatform({
          baseUrl: 'https://goodvibes.example.com',
          authToken: token,
        });

        const snapshot = await platformClient.operator.control.snapshot();
        if (cancelled) return;
        console.log(snapshot);

        // Hermes (React Native / Expo) has no header-capable WebSocket by
        // default; see docs/troubleshooting.md#websocket-implementation-is-required
        // if the WebSocketImpl option is rejected.
        const unsubscribe = platformClient.realtime
          .viaWebSocket(authorizedWebSocket(token))
          .agents.on('AGENT_COMPLETED', (event) => {
            console.log('agent completed', event);
          });
        if (cancelled) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
      } catch (error) {
        console.error('GoodVibes setup failed', error);
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return null;
}
