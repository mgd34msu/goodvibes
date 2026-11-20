/**
 * disposal-wiring.ts
 *
 * The daemon's async disposal scope. Every poller the runtime graph starts is
 * registered by the one composition (the engine's runtime-graph.ts) in its own
 * scope; the daemon's own owners (devices, cluster, native work, handler
 * surfaces) are registered in scopes built from this, which drain first.
 */
export { createAsyncDisposalScope as createDisposalScope } from '@goodvibes/engine/platform/platform/runtime/disposal';
