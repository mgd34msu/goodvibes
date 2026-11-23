/**
 * A local-network host name (a .local name, as a phone reaches a computer),
 * never a loopback one. Every journey's browser resolves it to 127.0.0.1
 * (playwright.config.ts), so a page opened at it has a non-loopback plain-http
 * origin while the daemon listens on loopback only.
 */
export const NETWORK_HOST = 'goodvibes-e2e.local';
