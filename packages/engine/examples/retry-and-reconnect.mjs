/**
 * Configure HTTP retry and realtime reconnect policies.
 */
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';

const authToken = process.env.GOODVIBES_TOKEN;
if (!authToken) {
  throw new Error('GOODVIBES_TOKEN env var is required (operator bearer token from the daemon).');
}
const platformClient = createGoodVibesPlatform({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  authToken,
  retry: {
    maxAttempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 2_500,
  },
  realtime: {
    sseReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
    webSocketReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
    onError(error) {
      console.error('realtime transport error', error);
    },
  },
});

console.log(await platformClient.operator.control.status());

const stop = platformClient.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});

const stopTimer = setTimeout(() => {
  stop();
}, 30_000);
stopTimer.unref?.();
