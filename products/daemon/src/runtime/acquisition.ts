// The runtime graph's acquisition scope lives in the engine, where every
// product's composition is built; the daemon's own owners use the same one.
export { createRuntimeAcquisitionScope } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
export type { RuntimeAcquisitionScope } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
