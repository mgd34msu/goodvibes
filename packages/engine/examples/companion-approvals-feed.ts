/**
 * Subscribe to approval updates from a browser companion surface.
 *
 * Both `@goodvibes-jev/engine/platform/browser` and `@goodvibes-jev/engine/platform/web` are valid
 * for browser companion code. This example uses `/browser` for explicit browser
 * context; use `/web` when you want web + service-worker defaults.
 */
import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
});

async function refreshApprovals() {
  // approvals.list() returns paginated results; pass { cursor } from the previous response
  // to page through all records when the list may exceed the default page size.
  const approvals = await platformClient.operator.approvals.list();
  console.log('approvals', approvals);
}

await refreshApprovals();

const stopAgentCompleted = platformClient.realtime.viaSse().agents.on('AGENT_COMPLETED', async () => {
  await refreshApprovals();
});

// window is typed because tsconfig includes lib: 'DOM'; in a browser this works at runtime.
// In a non-browser environment (test, SSR), the guard below skips registration.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopAgentCompleted();
  });
}
