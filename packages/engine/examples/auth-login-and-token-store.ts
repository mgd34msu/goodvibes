/**
 * Login with the operator API and persist the returned token in memory.
 */
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';
import { createMemoryTokenStore } from '@goodvibes-jev/engine/platform/auth';

const tokenStore = createMemoryTokenStore();

const platformClient = createGoodVibesPlatform({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  tokenStore,
});

const username = process.env.GOODVIBES_USERNAME;
const password = process.env.GOODVIBES_PASSWORD;
if (!username || !password) {
  throw new Error('GOODVIBES_USERNAME and GOODVIBES_PASSWORD env vars are required');
}

const login = await platformClient.auth.login({ username, password });

console.log('login succeeded', login.authenticated);
console.log('persisted token present', Boolean(await platformClient.auth.getToken()));
console.log('current auth', await platformClient.auth.current());
