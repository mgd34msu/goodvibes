import type { FetchLike } from '@goodvibes-jev/engine/transport-core';
import { ConfigurationError } from '@goodvibes-jev/engine/errors';
import {
  createGoodVibesPlatform,
  type GoodVibesPlatformOptions,
  type GoodVibesPlatform,
} from './client.js';

/**
 * Options for {@link createBrowserGoodVibesPlatform}.
 *
 * Extends {@link GoodVibesPlatformOptions} with browser-friendly defaults:
 * - `baseUrl` is optional and defaults to `location.origin`.
 * - `fetch` and `WebSocketImpl` default to the browser globals.
 *
 * This is the canonical options type for the browser entrypoint
 * (`@goodvibes-jev/engine/platform/browser`). The web entrypoint
 * (`@goodvibes-jev/engine/platform/web`) exposes the same shape as
 * `WebGoodVibesPlatformOptions`, a named alias retained for ergonomic imports.
 */
export interface BrowserGoodVibesPlatformOptions
  extends Omit<GoodVibesPlatformOptions, 'baseUrl' | 'fetch' | 'WebSocketImpl'> {
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly WebSocketImpl?: typeof WebSocket | undefined;
}

function resolveBrowserBaseUrl(baseUrl?: string): string {
  const explicit = baseUrl?.trim();
  if (explicit) return explicit;
  if (typeof globalThis.location?.origin === 'string' && globalThis.location.origin.trim()) {
    return globalThis.location.origin.trim();
  }
  throw new ConfigurationError(
    'Browser baseUrl is required when location.origin is unavailable.',
  );
}

/**
 * Create a GoodVibes platform instance for browser environments.
 *
 * Differences from `createGoodVibesPlatform`:
 * - `baseUrl` defaults to `location.origin` when omitted.
 * - HTTP retry and realtime reconnect are pre-configured with
 *   browser-appropriate defaults.
 * - Relies on the native browser `fetch` and `WebSocket` globals; pass
 *   `options.fetch` / `options.WebSocketImpl` to override.
 *
 * @example
 * // Example only: baseUrl defaults to location.origin in a real browser app.
 * import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';
 *
 * const platform = createBrowserGoodVibesPlatform({
 *   authToken: sessionStorage.getItem('gv-token') ?? undefined,
 * });
 *
 * const agents = await platform.operator.agents.list();
 */
export { forSession } from './companion-realtime.js';

export function createBrowserGoodVibesPlatform(
  options: BrowserGoodVibesPlatformOptions = {},
): GoodVibesPlatform {
  return createGoodVibesPlatform({
    ...options,
    baseUrl: resolveBrowserBaseUrl(options.baseUrl),
    authToken: options.authToken ?? null,
    ...(options.retry ? { retry: options.retry } : {
      retry: {
        maxAttempts: 3,
        baseDelayMs: 200,
        maxDelayMs: 1_500,
      },
    }),
    realtime: {
      ...(options.realtime ?? {}),
      sseReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.sseReconnect ?? {}),
      },
      webSocketReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.webSocketReconnect ?? {}),
      },
    },
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
    ...(options.tokenStore ? { tokenStore: options.tokenStore } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.getHeaders ? { getHeaders: options.getHeaders } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
  });
}
