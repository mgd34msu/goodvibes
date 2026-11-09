/**
 * Call operator endpoints over HTTP using the umbrella platform.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3421).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: bun examples/operator-http-quickstart.mjs
 */
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';

const authToken = process.env.GOODVIBES_TOKEN;
if (!authToken) {
  throw new Error('GOODVIBES_TOKEN env var is required (operator bearer token from the daemon).');
}
const platformClient = createGoodVibesPlatform({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  authToken,
});

const snapshot = await platformClient.operator.control.snapshot();
console.log(JSON.stringify(snapshot, null, 2));
