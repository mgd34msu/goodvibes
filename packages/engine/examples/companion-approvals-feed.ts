/**
 * Subscribe to approval updates from a browser companion surface.
 *
 * Both `@goodvibes/engine/platform/browser` and `@goodvibes/engine/platform/web` are valid
 * for browser companion code. This example uses `/browser` for explicit browser
 * context; use `/web` when you want web + service-worker defaults.
 */
import { createBrowserGoodVibesPlatform } from '@goodvibes/engine/platform/browser';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
});

async function refreshApprovals() {
  // approvals.list() returns paginated results; pass { cursor } from the previous response
  // to page through all records when the list may exceed the default page size.
  const approvals = await platformClient.operator.approvals.list();
  console.log('approvals', approvals);
}

// A refresh that fails must not become an unhandled rejection inside an event handler.
function refreshApprovalsSafely(): void {
  refreshApprovals().catch((error: unknown) => {
    console.error('approvals refresh failed', error);
  });
}

await refreshApprovals();

// A node waiting on an approval raises FLEET_NODE_BLOCKED_ON_USER (reason 'approval');
// FLEET_NODE_UNBLOCKED fires once it has been answered. Both change the approvals list.
const fleetEvents = platformClient.realtime.viaSse().fleet;
const stopBlocked = fleetEvents.on('FLEET_NODE_BLOCKED_ON_USER', (event) => {
  if (event.reason === 'approval') refreshApprovalsSafely();
});
const stopUnblocked = fleetEvents.on('FLEET_NODE_UNBLOCKED', () => {
  refreshApprovalsSafely();
});

// window is typed because tsconfig includes lib: 'DOM'; in a browser this works at runtime.
// In a non-browser environment (test, SSR), the guard below skips registration.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopBlocked();
    stopUnblocked();
  });
}
