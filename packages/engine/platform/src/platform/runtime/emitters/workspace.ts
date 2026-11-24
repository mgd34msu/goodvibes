/**
 * Workspace emitters, typed wrappers for the WorkspaceEvent domain events a
 * host emits from a store's own change (the swap manager emits its own).
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { WorkspaceEvent } from '../../../events/workspace.js';
import type { EmitterContext } from './index.js';

/** The store-side notice LIST_CHANGED is forwarded from (a host subscribes once and emits each). */
export { noteListChanged, onListChanged, type ChangedList, type ListChange } from '../list-changes.js';

type NativeRequestChanged = Extract<WorkspaceEvent, { type: 'NATIVE_REQUEST_CHANGED' }>;
type ListChanged = Extract<WorkspaceEvent, { type: 'LIST_CHANGED' }>;

/** A list a client shows changed (runtime/list-changes.ts). */
export function emitListChanged(bus: RuntimeEventBus, ctx: EmitterContext, data: Omit<ListChanged, 'type'>): void {
  bus.emit('workspace', createEventEnvelope('LIST_CHANGED', { type: 'LIST_CHANGED', ...data } as ListChanged, ctx));
}

/** A committed write to a native request (knowledge/store.ts onNativeRequestChange). */
export function emitNativeRequestChanged(bus: RuntimeEventBus, ctx: EmitterContext, data: Omit<NativeRequestChanged, 'type'>): void {
  bus.emit('workspace', createEventEnvelope('NATIVE_REQUEST_CHANGED', { type: 'NATIVE_REQUEST_CHANGED', ...data } as NativeRequestChanged, ctx));
}
