/** Compatibility path; the daemon and Agent share the same held/recovery fences. */
export { createNativeInboundHandoff } from '@goodvibes/engine/platform/platform/control-plane';
export type { NativeInboundDisposition, NativeInboundAcceptance, NativeInboundProcessingOwner, NativeInboundReceiver } from '@goodvibes/engine/platform/platform/control-plane';
