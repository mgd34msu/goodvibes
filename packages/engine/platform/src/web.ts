import {
  createBrowserGoodVibesPlatform,
  type BrowserGoodVibesPlatformOptions,
} from './browser.js';
import type { GoodVibesPlatform } from './client.js';

/**
 * Options for {@link createWebGoodVibesPlatform}.
 *
 * This type is an alias for {@link BrowserGoodVibesPlatformOptions} and carries the
 * same shape. It exists so that code importing from `@goodvibes-jev/engine/platform/web`
 * has a semantically accurate name without requiring an empty-interface declaration.
 *
 * Use `WebGoodVibesPlatformOptions` when importing from `@goodvibes-jev/engine/platform/web`;
 * use {@link BrowserGoodVibesPlatformOptions} when importing from
 * `@goodvibes-jev/engine/platform/browser`.
 */
export type WebGoodVibesPlatformOptions = BrowserGoodVibesPlatformOptions;

export { forSession } from './companion-realtime.js';

/**
 * Create a GoodVibes platform instance from the web-specific entrypoint.
 */
export function createWebGoodVibesPlatform(options: WebGoodVibesPlatformOptions = {}): GoodVibesPlatform {
  return createBrowserGoodVibesPlatform(options);
}
