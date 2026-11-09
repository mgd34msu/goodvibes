/**
 * Create a browser client for GoodVibes web UI integrations.
 */
import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
});

await platformClient.operator.control.snapshot();

const unsubscribe = platformClient.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});

window.addEventListener('beforeunload', () => {
  unsubscribe();
});
