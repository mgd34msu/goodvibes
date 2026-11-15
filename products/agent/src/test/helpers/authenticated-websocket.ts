// Deliberately per-repo test scaffolding: it binds to this repo's own working tree, source layout and Bun test lifecycle, and has no counterpart in the sibling product.
export function createAuthenticatedWebSocket(token: string): typeof WebSocket {
  class AuthenticatedWebSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      } as unknown as string | string[]);
    }
  }

  return AuthenticatedWebSocket as unknown as typeof WebSocket;
}
